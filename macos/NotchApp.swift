import Cocoa
import WebKit
import AVFoundation
import Carbon
import Security

// Global reference for Carbon HotKey C callback
private weak var sharedAppDelegate: AppDelegate?

private func carbonHotKeyHandler(
    nextHandler: EventHandlerCallRef?,
    theEvent: EventRef?,
    userData: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let theEvent = theEvent else { return OSStatus(eventNotHandledErr) }
    var hotKeyID = EventHotKeyID()
    let status = GetEventParameter(
        theEvent,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &hotKeyID
    )
    if status == noErr {
        DispatchQueue.main.async {
            switch hotKeyID.id {
            case 1:
                sharedAppDelegate?.toggleNotchExpand()
            case 2:
                sharedAppDelegate?.toggleVoiceCall()
            case 3:
                sharedAppDelegate?.cyclePrevBot()
            case 4:
                sharedAppDelegate?.cycleNextBot()
            case 5:
                sharedAppDelegate?.handleEscapeKey()
            default:
                break
            }
        }
    }
    return noErr
}

// MARK: - Non-Activating Borderless Notch Panel
final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

// MARK: - Transparent WebView with First-Click Acceptance
final class NotchWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        return true
    }
}

// MARK: - Native 24kHz AVAudioEngine Voice Pipeline
final class NativeVoiceAudioController {
    private var engine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var targetFormat: AVAudioFormat?
    private var playerFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var isRunning = false
    private var isMuted = false
    private var pendingBuffers = 0
    weak var webView: WKWebView?

    func setMuted(_ muted: Bool) {
        self.isMuted = muted
    }

    func start() {
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            guard granted else { return }
            DispatchQueue.main.async {
                self?.setupAndStartEngine()
            }
        }
    }

    private func setupAndStartEngine() {
        stop()

        let eng = AVAudioEngine()
        let player = AVAudioPlayerNode()
        eng.attach(player)

        guard let playFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false),
              let micTargetFmt = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true) else {
            return
        }
        self.playerFormat = playFmt
        self.targetFormat = micTargetFmt

        eng.connect(player, to: eng.mainMixerNode, format: playFmt)

        let inputNode = eng.inputNode
        let hwFormat = inputNode.inputFormat(forBus: 0)
        guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else { return }

        guard let conv = AVAudioConverter(from: hwFormat, to: micTargetFmt) else { return }
        self.converter = conv

        inputNode.installTap(onBus: 0, bufferSize: 2048, format: hwFormat) { [weak self] buffer, _ in
            guard let self = self, self.isRunning, !self.isMuted else { return }
            self.processMicBuffer(buffer, converter: conv, targetFormat: micTargetFmt)
        }

        do {
            try eng.start()
            player.play()
            self.engine = eng
            self.playerNode = player
            self.isRunning = true
        } catch {
            NSLog("[GrokBotNotch] AVAudioEngine start failed: \(error)")
        }
    }

    private func processMicBuffer(_ buffer: AVAudioPCMBuffer, converter: AVAudioConverter, targetFormat: AVAudioFormat) {
        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }

        var consumed = false
        var error: NSError?
        converter.convert(to: outBuffer, error: &error) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        }

        guard error == nil, outBuffer.frameLength > 0, let int16Ptr = outBuffer.int16ChannelData?[0] else { return }
        let frameCount = Int(outBuffer.frameLength)
        var sumSquares: Float = 0
        for i in 0..<frameCount {
            let norm = Float(int16Ptr[i]) / 32768.0
            sumSquares += norm * norm
        }
        let rms = sqrt(sumSquares / Float(max(1, frameCount)))
        let byteCount = frameCount * 2
        let data = Data(bytes: int16Ptr, count: byteCount)
        let b64 = data.base64EncodedString()

        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.isRunning else { return }
            let reportedRms = (self.pendingBuffers == 0) ? rms : 0
            self.webView?.evaluateJavaScript(
                "window.__onNativeMicFrame && window.__onNativeMicFrame('\(b64)', \(reportedRms))",
                completionHandler: nil
            )
        }
    }

    func playBase64Pcm16(_ base64: String) {
        guard isRunning, let player = playerNode, let playFmt = playerFormat else { return }
        guard let data = Data(base64Encoded: base64), data.count >= 2 else { return }
        let sampleCount = data.count / 2
        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: playFmt, frameCapacity: AVAudioFrameCount(sampleCount)),
              let floatChannel = pcmBuffer.floatChannelData?[0] else { return }

        pcmBuffer.frameLength = AVAudioFrameCount(sampleCount)
        var sumSquares: Float = 0

        data.withUnsafeBytes { rawBuf in
            guard let int16Base = rawBuf.bindMemory(to: Int16.self).baseAddress else { return }
            for i in 0..<sampleCount {
                let sample = Float(int16Base[i]) / 32768.0
                floatChannel[i] = sample
                sumSquares += sample * sample
            }
        }

        let rms = sqrt(sumSquares / Float(max(1, sampleCount)))
        pendingBuffers += 1
        if !player.isPlaying {
            player.play()
        }

        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(
                "window.__onNativeSpeakerEnergy && window.__onNativeSpeakerEnergy(\(rms))",
                completionHandler: nil
            )
        }

        player.scheduleBuffer(pcmBuffer) { [weak self] in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.pendingBuffers = max(0, self.pendingBuffers - 1)
                if self.pendingBuffers == 0 {
                    self.webView?.evaluateJavaScript(
                        "window.__onNativeSpeakerEnergy && window.__onNativeSpeakerEnergy(0); window.__onNativeSpeechEnded && window.__onNativeSpeechEnded();",
                        completionHandler: nil
                    )
                }
            }
        }
    }

    func stopPlayback() {
        guard let player = playerNode else { return }
        player.stop()
        player.play()
        pendingBuffers = 0
        webView?.evaluateJavaScript("window.__onNativeSpeakerEnergy && window.__onNativeSpeakerEnergy(0)", completionHandler: nil)
    }

    func stop() {
        isRunning = false
        pendingBuffers = 0
        if let eng = engine {
            eng.inputNode.removeTap(onBus: 0)
            playerNode?.stop()
            eng.stop()
        }
        engine = nil
        playerNode = nil
        converter = nil
    }
}

// MARK: - Main Application Delegate
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKUIDelegate {
    private var panel: NotchPanel!
    private var webView: NotchWebView!
    private var statusItem: NSStatusItem!
    private var serverProcess: Process?
    private var launchAuthToken: String?
    private let audioController = NativeVoiceAudioController()

    private let panelWidth: CGFloat = 400
    private let panelHeight: CGFloat = 320
    private var hitRectInPanel = NSRect(x: 94, y: 0, width: 212, height: 56)
    private var isNotchOpen = false
    private var isTypingInNotch = false
    private var currentBotName = "Chief"
    private var currentCallPhase = "idle"
    private var rosterBots: [[String: String]] = []
    private var selectedBotId: String = ""

    private var globalMouseMonitor: Any?
    private var globalClickMonitor: Any?
    private var localMouseMonitor: Any?
    private var toggleHotKeyRef: EventHotKeyRef?
    private var voiceHotKeyRef: EventHotKeyRef?
    private var leftArrowHotKeyRef: EventHotKeyRef?
    private var rightArrowHotKeyRef: EventHotKeyRef?
    private var escapeHotKeyRef: EventHotKeyRef?

    func applicationDidFinishLaunching(_ notification: Notification) {
        sharedAppDelegate = self
        NSApp.setActivationPolicy(.accessory)

        registerCarbonGlobalHotKeys()

        ensureNodeServerRunning { [weak self] in
            DispatchQueue.main.async {
                self?.setupStatusItem()
                self?.setupNotchPanel()
                self?.setupEventMonitors()
            }
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(repositionNotchPanel),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
    }

    func applicationWillTerminate(_ notification: Notification) {
        audioController.stop()
        if let hk1 = toggleHotKeyRef { UnregisterEventHotKey(hk1) }
        if let hk2 = voiceHotKeyRef { UnregisterEventHotKey(hk2) }
        updateExpandedNavigationHotKeys(active: false, includeArrows: false)
        if let proc = serverProcess, proc.isRunning {
            proc.terminate()
        }
    }

    private func updateExpandedNavigationHotKeys(active: Bool, includeArrows: Bool) {
        if let hk = leftArrowHotKeyRef {
            UnregisterEventHotKey(hk)
            leftArrowHotKeyRef = nil
        }
        if let hk = rightArrowHotKeyRef {
            UnregisterEventHotKey(hk)
            rightArrowHotKeyRef = nil
        }
        if let hk = escapeHotKeyRef {
            UnregisterEventHotKey(hk)
            escapeHotKeyRef = nil
        }

        guard active else { return }

        let escID = EventHotKeyID(signature: OSType(0x47424E35), id: 5)
        RegisterEventHotKey(
            UInt32(kVK_Escape),
            0,
            escID,
            GetApplicationEventTarget(),
            0,
            &escapeHotKeyRef
        )

        if includeArrows {
            let leftID = EventHotKeyID(signature: OSType(0x47424E33), id: 3)
            RegisterEventHotKey(
                UInt32(kVK_LeftArrow),
                0,
                leftID,
                GetApplicationEventTarget(),
                0,
                &leftArrowHotKeyRef
            )

            let rightID = EventHotKeyID(signature: OSType(0x47424E34), id: 4)
            RegisterEventHotKey(
                UInt32(kVK_RightArrow),
                0,
                rightID,
                GetApplicationEventTarget(),
                0,
                &rightArrowHotKeyRef
            )
        }
    }

    // MARK: - Carbon Global HotKeys (Works Across All Apps Without Accessibility Prompts)
    private func registerCarbonGlobalHotKeys() {
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        InstallEventHandler(
            GetApplicationEventTarget(),
            carbonHotKeyHandler,
            1,
            &eventType,
            nil,
            nil
        )

        // HotKey 1: Option + Space (keyCode 49) -> Toggle Notch Expand/Collapse
        let hkID1 = EventHotKeyID(signature: OSType(0x47424E31), id: 1)
        RegisterEventHotKey(
            UInt32(kVK_Space),
            UInt32(optionKey),
            hkID1,
            GetApplicationEventTarget(),
            0,
            &toggleHotKeyRef
        )

        // HotKey 2: Cmd + Shift + G (keyCode 5) -> Toggle Voice Mode
        let hkID2 = EventHotKeyID(signature: OSType(0x47424E32), id: 2)
        RegisterEventHotKey(
            UInt32(kVK_ANSI_G),
            UInt32(cmdKey | shiftKey),
            hkID2,
            GetApplicationEventTarget(),
            0,
            &voiceHotKeyRef
        )
    }

    // MARK: - Node Server Management
    private func launchAuthTokenFilePath() -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/Library/Application Support/GrokBot Notch/launch-auth-token"
    }

    private func readLaunchAuthTokenFromDisk() -> String? {
        let path = launchAuthTokenFilePath()
        guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : token
    }

    private func generateLaunchAuthToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            return UUID().uuidString.replacingOccurrences(of: "-", with: "") + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        }
        let data = Data(bytes)
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func resolveLaunchAuthToken() -> String? {
        if let token = launchAuthToken, !token.isEmpty { return token }
        if let disk = readLaunchAuthTokenFromDisk() {
            launchAuthToken = disk
            return disk
        }
        return nil
    }

    private func bootstrapHealthCheck(token: String?, completion: @escaping (Bool) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:4789/api/bootstrap") else {
            completion(false)
            return
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 0.6
        if let token = token, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        URLSession.shared.dataTask(with: req) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            completion(ok)
        }.resume()
    }

    private func ensureNodeServerRunning(completion: @escaping () -> Void) {
        if launchAuthToken == nil {
            launchAuthToken = readLaunchAuthTokenFromDisk()
        }
        bootstrapHealthCheck(token: launchAuthToken) { [weak self] healthy in
            guard let self = self else {
                completion()
                return
            }
            if healthy {
                completion()
                return
            }
            if self.launchAuthToken == nil, let diskToken = self.readLaunchAuthTokenFromDisk() {
                self.launchAuthToken = diskToken
                self.bootstrapHealthCheck(token: diskToken) { healthyWithDisk in
                    if healthyWithDisk {
                        completion()
                    } else {
                        self.spawnEmbeddedNodeServer(completion: completion)
                    }
                }
                return
            }
            self.spawnEmbeddedNodeServer(completion: completion)
        }
    }

    private func spawnEmbeddedNodeServer(completion: @escaping () -> Void) {
        let bundleServerPath = Bundle.main.resourceURL?.appendingPathComponent("app/server.mjs").path
        let siblingServerPath = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("server.mjs").path
        let serverPath: String
        if let bPath = bundleServerPath, FileManager.default.fileExists(atPath: bPath) {
            serverPath = bPath
        } else {
            serverPath = siblingServerPath
        }

        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let nodeCandidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "\(home)/.nvm/current/bin/node",
            "\(home)/.volta/bin/node",
            "\(home)/.local/share/fnm/aliases/default/bin/node"
        ]
        let nodeBin = nodeCandidates.first { FileManager.default.isExecutableFile(atPath: $0) } ?? "/usr/bin/env"
        let proc = Process()
        if nodeBin == "/usr/bin/env" {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["node", serverPath]
        } else {
            proc.executableURL = URL(fileURLWithPath: nodeBin)
            proc.arguments = [serverPath]
        }
        proc.currentDirectoryURL = URL(fileURLWithPath: (serverPath as NSString).deletingLastPathComponent)
        let token = generateLaunchAuthToken()
        self.launchAuthToken = token
        var env = ProcessInfo.processInfo.environment
        env["GROKBOT_NOTCH_AUTH_TOKEN"] = token
        proc.environment = env
        do {
            try proc.run()
            self.serverProcess = proc
        } catch {
            NSLog("[GrokBotNotch] Failed to start server.mjs: \(error)")
        }

        DispatchQueue.global().asyncAfter(deadline: .now() + 0.55) { [weak self] in
            if self?.resolveLaunchAuthToken() == nil {
                self?.launchAuthToken = self?.readLaunchAuthTokenFromDisk()
            }
            completion()
        }
    }

    // MARK: - Main Screen & Hardware Notch Detection
    private func primaryMacScreen() -> NSScreen? {
        if #available(macOS 12.0, *) {
            if let notched = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) {
                return notched
            }
        }
        return NSScreen.screens.first ?? NSScreen.main
    }

    private func detectHardwareNotchGeometry(for screen: NSScreen) -> (width: CGFloat, height: CGFloat) {
        if #available(macOS 12.0, *) {
            if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
                let gap = screen.frame.width - left.width - right.width
                let h = max(32, screen.safeAreaInsets.top)
                if gap > 100 && gap < 320 {
                    return (gap, h)
                }
            }
        }
        return (185, 32)
    }

    private func setupNotchPanel() {
        guard let screen = primaryMacScreen() else { return }
        let frame = NSRect(
            x: screen.frame.midX - panelWidth / 2,
            y: screen.frame.maxY - panelHeight,
            width: panelWidth,
            height: panelHeight
        )

        panel = NotchPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.statusWindow)) + 2)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.acceptsMouseMovedEvents = true

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "notchHost")
        config.mediaTypesRequiringUserActionForPlayback = []

        if let token = resolveLaunchAuthToken() {
            let escaped = token
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            let scriptSource = "window.__GROKBOT_NOTCH_AUTH_TOKEN='\(escaped)';"
            let userScript = WKUserScript(source: scriptSource, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            config.userContentController.addUserScript(userScript)
        }

        webView = NotchWebView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight), configuration: config)
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsMagnification = false

        audioController.webView = webView
        panel.contentView = webView
        panel.orderFrontRegardless()

        if let url = URL(string: "http://127.0.0.1:4789/?native=1") {
            webView.load(URLRequest(url: url))
        }

        let notchGeo = detectHardwareNotchGeometry(for: screen)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in
            self?.sendCommandToWeb([
                "action": "setNotchGeometry",
                "notchWidth": Int(notchGeo.width),
                "notchHeight": Int(notchGeo.height)
            ])
        }
    }

    @objc private func repositionNotchPanel() {
        guard let screen = primaryMacScreen(), let panel = panel else { return }
        let frame = NSRect(
            x: screen.frame.midX - panelWidth / 2,
            y: screen.frame.maxY - panelHeight,
            width: panelWidth,
            height: panelHeight
        )
        panel.setFrame(frame, display: true)
    }

    // MARK: - Surgical Hit-Testing & Cursor Gaze Monitors
    private func setupEventMonitors() {
        let handleMouseMove: () -> Void = { [weak self] in
            self?.updateMousePassthroughAndGaze()
        }

        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: { _ in
            handleMouseMove()
        })

        // Collapse when clicking outside the expanded notch (if no voice call is active)
        globalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] _ in
            guard let self = self, self.isNotchOpen, self.currentCallPhase == "idle", let panel = self.panel else { return }
            let mouseScreen = NSEvent.mouseLocation
            let panelFrame = panel.frame
            let localX = mouseScreen.x - panelFrame.minX
            let localTopY = panelFrame.maxY - mouseScreen.y
            if !self.hitRectInPanel.insetBy(dx: -10, dy: -10).contains(NSPoint(x: localX, y: localTopY)) {
                self.sendCommandToWeb(["action": "toggleExpand"])
            }
        })

        localMouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDown, .rightMouseDown], handler: { event in
            handleMouseMove()
            return event
        })
    }

    private func updateMousePassthroughAndGaze() {
        guard let panel = panel else { return }
        let mouseScreen = NSEvent.mouseLocation
        let panelFrame = panel.frame

        let localX = mouseScreen.x - panelFrame.minX
        let localTopY = panelFrame.maxY - mouseScreen.y

        let paddedHitRect = hitRectInPanel.insetBy(dx: -10, dy: -6)
        let isInside = paddedHitRect.contains(NSPoint(x: localX, y: localTopY))

        if panel.ignoresMouseEvents == isInside {
            panel.ignoresMouseEvents = !isInside
        }

        if isNotchOpen && localTopY >= -20 && localTopY <= panelHeight + 80 && localX >= -120 && localX <= panelWidth + 120 {
            webView?.evaluateJavaScript(
                "window.__onNativeCursorMove && window.__onNativeCursorMove(\(Int(localX)), \(Int(localTopY)))",
                completionHandler: nil
            )
        }
    }

    // MARK: - Menu Bar Status Item
    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateStatusItemAppearance()
        rebuildStatusMenu()
    }

    private func updateStatusItemAppearance() {
        guard let button = statusItem?.button else { return }
        if currentCallPhase == "live" || currentCallPhase == "connecting" {
            button.title = "🎙️ \(currentBotName)"
        } else {
            button.title = "✦ \(currentBotName)"
        }
    }

    private func rebuildStatusMenu() {
        let menu = NSMenu()

        let toggleItem = NSMenuItem(title: "Toggle GrokBot Notch (⌥Space)", action: #selector(toggleNotchExpand), keyEquivalent: "")
        menu.addItem(toggleItem)

        let callTitle = (currentCallPhase == "idle")
            ? "Start Voice Call with \(currentBotName) (⌘⇧G)"
            : "End Voice Call (\(currentBotName))"
        let callItem = NSMenuItem(title: callTitle, action: #selector(toggleVoiceCall), keyEquivalent: "")
        menu.addItem(callItem)

        menu.addItem(NSMenuItem.separator())

        if !rosterBots.isEmpty {
            let header = NSMenuItem(title: "Bots", action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)

            for bot in rosterBots {
                guard let id = bot["id"], let name = bot["name"] else { continue }
                let item = NSMenuItem(title: name, action: #selector(selectBotFromMenu(_:)), keyEquivalent: "")
                item.representedObject = id
                item.state = (id == selectedBotId) ? .on : .off
                menu.addItem(item)
            }
            menu.addItem(NSMenuItem.separator())
        }

        let openDesktop = NSMenuItem(title: "Open Desktop Grok Bot.app", action: #selector(openDesktopApp), keyEquivalent: "o")
        menu.addItem(openDesktop)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "Quit GrokBot Notch", action: #selector(quitApp), keyEquivalent: "q")
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    @objc func toggleNotchExpand() {
        repositionNotchPanel()
        panel.ignoresMouseEvents = false
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        sendCommandToWeb(["action": "toggleExpand"])
    }

    @objc func toggleVoiceCall() {
        repositionNotchPanel()
        panel.ignoresMouseEvents = false
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        sendCommandToWeb(["action": "toggleVoiceCall"])
    }

    func cyclePrevBot() {
        sendCommandToWeb(["action": "prevBot"])
    }

    func cycleNextBot() {
        sendCommandToWeb(["action": "nextBot"])
    }

    func handleEscapeKey() {
        sendCommandToWeb(["action": "escape"])
    }

    @objc private func selectBotFromMenu(_ sender: NSMenuItem) {
        guard let botId = sender.representedObject as? String else { return }
        selectedBotId = botId
        panel.ignoresMouseEvents = false
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        sendCommandToWeb(["action": "selectBot", "botId": botId])
    }

    @objc private func openDesktopApp() {
        NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Grok Bot.app"))
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }

    private func sendCommandToWeb(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__notchCommand && window.__notchCommand(\(json))", completionHandler: nil)
    }

    // MARK: - WKScriptMessageHandler & WKUIDelegate
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }

        switch type {
        case "hitRect":
            let x = CGFloat((body["x"] as? NSNumber)?.doubleValue ?? 94)
            let y = CGFloat((body["y"] as? NSNumber)?.doubleValue ?? 0)
            let w = CGFloat((body["width"] as? NSNumber)?.doubleValue ?? 212)
            let h = CGFloat((body["height"] as? NSNumber)?.doubleValue ?? 56)
            hitRectInPanel = NSRect(x: x, y: y, width: w, height: h)
            let wasOpen = isNotchOpen
            isNotchOpen = (body["isOpen"] as? Bool) ?? false
            isTypingInNotch = (body["isTyping"] as? Bool) ?? false

            updateExpandedNavigationHotKeys(active: isNotchOpen, includeArrows: isNotchOpen && !isTypingInNotch)

            if isNotchOpen && !wasOpen {
                panel.ignoresMouseEvents = false
                NSApp.activate(ignoringOtherApps: true)
                panel.makeKeyAndOrderFront(nil)
                panel.makeFirstResponder(webView)
            }

            if let botName = body["botName"] as? String, !botName.isEmpty {
                currentBotName = botName
            }
            if let phase = body["callPhase"] as? String {
                currentCallPhase = phase
            }
            updateStatusItemAppearance()
            rebuildStatusMenu()

        case "rosterLoaded":
            if let bots = body["bots"] as? [[String: String]] {
                rosterBots = bots
            }
            if let sel = body["selectedBotId"] as? String {
                selectedBotId = sel
            }
            rebuildStatusMenu()

        case "audioStart":
            audioController.start()

        case "audioPlay":
            if let b64 = body["base64"] as? String {
                audioController.playBase64Pcm16(b64)
            }

        case "audioStopPlayback":
            audioController.stopPlayback()

        case "audioSetMuted":
            let muted = (body["muted"] as? Bool) ?? false
            audioController.setMuted(muted)

        case "audioStop":
            audioController.stop()

        default:
            break
        }
    }

    @available(macOS 12.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.grant)
    }
}

// MARK: - Entry Point
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
