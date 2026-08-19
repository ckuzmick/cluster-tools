// clusterbar — a macOS menu-bar readout of your cluster jobs.
//
// Build once (needs Xcode Command Line Tools, same as touchid.swift):
//   swiftc -O menubar.swift -o clusterbar
// Run it:
//   ./clusterbar &                 # or add to Login Items to have it always up
//
// It polls `cluster status --json`, which by design never logs in: if the
// shared ssh session is down the bar shows a dash and nothing is attempted.
// That matters — a background poller that could trigger the TOTP login flow
// would burn one-time codes and risk locking the account.

import AppKit

let pollSeconds: TimeInterval = {
    if let s = ProcessInfo.processInfo.environment["CLUSTERBAR_INTERVAL"], let v = Double(s) { return max(10, v) }
    return 30
}()

struct Job {
    var id = "", name = "", state = "", elapsed = "", limit = ""
    var cpus = 0
    var stagePct: Int?
    var solvesDone: Int?
    var multiStage = false
    var finishEastern: String?
}

final class Bar: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var timer: Timer?
    var polling = false
    var session = "unknown"
    var jobs: [Job] = []
    var lastCheck = Date.distantPast

    func applicationDidFinishLaunching(_ n: Notification) {
        // Text only. A bare NSImage(systemSymbolName:) has no size set, which
        // collapses a variableLength status item to zero width — the item then
        // reports visible=true while rendering nothing at all.
        item.button?.title = "◌ …"
        item.menu = NSMenu()
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: pollSeconds, repeats: true) { [weak self] _ in self?.poll() }
    }

    /// Locate the `cluster` CLI without assuming a shell profile is loaded.
    func clusterBin() -> String {
        if let e = ProcessInfo.processInfo.environment["CLUSTERBAR_BIN"] { return e }
        for p in ["/opt/homebrew/bin/cluster", "/usr/local/bin/cluster"] where FileManager.default.isExecutableFile(atPath: p) {
            return p
        }
        return "/usr/bin/env"
    }

    func poll() {
        if polling { return }          // never stack a second ssh on a slow one
        polling = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let bin = self.clusterBin()
            let task = Process()
            task.executableURL = URL(fileURLWithPath: bin)
            task.arguments = bin.hasSuffix("env") ? ["cluster", "status", "--json"] : ["status", "--json"]
            let pipe = Pipe()
            task.standardOutput = pipe
            task.standardError = FileHandle.nullDevice
            var out = Data()
            do {
                try task.run()
                out = pipe.fileHandleForReading.readDataToEndOfFile()
                task.waitUntilExit()
            } catch {
                DispatchQueue.main.async { self.session = "error"; self.jobs = []; self.render(); self.polling = false }
                return
            }
            let obj = (try? JSONSerialization.jsonObject(with: out)) as? [String: Any]
            var parsed: [Job] = []
            for raw in (obj?["jobs"] as? [[String: Any]]) ?? [] {
                var j = Job()
                j.id = raw["id"] as? String ?? ""
                j.name = raw["name"] as? String ?? ""
                j.state = raw["state"] as? String ?? ""
                j.elapsed = raw["elapsed"] as? String ?? ""
                j.limit = raw["limit"] as? String ?? ""
                j.cpus = raw["cpus"] as? Int ?? 0
                j.stagePct = raw["stagePct"] as? Int
                j.solvesDone = raw["solvesDone"] as? Int
                j.multiStage = raw["multiStage"] as? Bool ?? false
                j.finishEastern = raw["finishEastern"] as? String
                parsed.append(j)
            }
            let sess = obj?["session"] as? String ?? "error"
            DispatchQueue.main.async {
                self.session = sess
                self.jobs = parsed
                self.lastCheck = Date()
                self.render()
                self.polling = false
            }
        }
    }

    func short(_ s: String, _ n: Int) -> String {
        s.count <= n ? s : String(s.prefix(n - 1)) + "…"
    }

    func render() {
        guard let button = item.button else { return }
        var title = ""
        let verbose = ProcessInfo.processInfo.environment["CLUSTERBAR_STYLE"] == "full"

        switch session {
        case "down":
            title = "◌"
            button.appearsDisabled = true
        case "error":
            title = "◌?"
            button.appearsDisabled = true
        default:
            button.appearsDisabled = false
            let running = jobs.filter { $0.state == "RUNNING" }
            if jobs.isEmpty {
                title = "○"
            } else if jobs.count == 1, let j = jobs.first {
                let name = verbose ? short(j.name, 12) + " " : ""
                if j.state == "RUNNING" {
                    // A percentage only when it means whole-job progress: COMSOL
                    // restarts its meter per stage, so a multi-stage job shows
                    // elapsed time instead of a number that would read as
                    // "nearly done" while it is not.
                    if !j.multiStage, let p = j.stagePct, p > 0 {
                        title = "◉ \(name)\(p)%"
                    } else {
                        title = "◉ \(name)\(j.elapsed)"
                    }
                } else {
                    title = "◍ \(name)\(j.state == "PENDING" ? "queued" : j.state.lowercased())"
                }
            } else {
                title = running.isEmpty ? "◍ \(jobs.count)" : "◉ \(running.count)/\(jobs.count)"
            }
        }
        button.title = title
        rebuildMenu()
    }

    func rebuildMenu() {
        let menu = NSMenu()
        let df = DateFormatter(); df.dateFormat = "HH:mm:ss"

        switch session {
        case "down":
            menu.addItem(withTitle: "No cluster session", action: nil, keyEquivalent: "")
            menu.addItem(withTitle: "Run `cluster login` in a terminal", action: nil, keyEquivalent: "")
        case "error":
            menu.addItem(withTitle: "Could not read status", action: nil, keyEquivalent: "")
        default:
            if jobs.isEmpty {
                menu.addItem(withTitle: "No jobs in the queue", action: nil, keyEquivalent: "")
            }
            for j in jobs {
                let head = NSMenuItem(title: "\(j.name)  —  \(j.state) \(j.elapsed) / \(j.limit)", action: nil, keyEquivalent: "")
                head.attributedTitle = NSAttributedString(
                    string: head.title,
                    attributes: [.font: NSFont.menuFont(ofSize: 0).withSize(13)])
                menu.addItem(head)
                var detail = "job \(j.id) · \(j.cpus) cpu"
                if let p = j.stagePct {
                    detail += j.multiStage
                        ? " · stage \(p)% · \(j.solvesDone ?? 0) solves done"
                        : " · \(p)% complete"
                }
                if let f = j.finishEastern { detail += " · done ~\(f)" }
                let sub = NSMenuItem(title: detail, action: nil, keyEquivalent: "")
                sub.attributedTitle = NSAttributedString(
                    string: "   " + detail,
                    attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular),
                                 .foregroundColor: NSColor.secondaryLabelColor])
                menu.addItem(sub)

                let watch = NSMenuItem(title: "Watch \(j.name) in Terminal", action: #selector(watchJob(_:)), keyEquivalent: "")
                watch.target = self
                watch.representedObject = j.id
                menu.addItem(watch)
                menu.addItem(.separator())
            }
        }

        if lastCheck != .distantPast {
            let stamp = NSMenuItem(title: "checked \(df.string(from: lastCheck))", action: nil, keyEquivalent: "")
            stamp.attributedTitle = NSAttributedString(
                string: "checked \(df.string(from: lastCheck))  ·  every \(Int(pollSeconds))s",
                attributes: [.font: NSFont.menuFont(ofSize: 11),
                             .foregroundColor: NSColor.tertiaryLabelColor])
            menu.addItem(stamp)
        }
        let refresh = NSMenuItem(title: "Refresh now", action: #selector(refreshNow), keyEquivalent: "r")
        refresh.target = self
        menu.addItem(refresh)
        let quit = NSMenuItem(title: "Quit clusterbar", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
    }

    @objc func watchJob(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        let script = "tell application \"Terminal\" to do script \"cluster watch \(id)\"\n"
            + "tell application \"Terminal\" to activate"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script]
        try? p.run()
    }

    @objc func refreshNow() { poll() }
    @objc func quit() { NSApplication.shared.terminate(nil) }
}

let app = NSApplication.shared
let bar = Bar()
app.delegate = bar
app.setActivationPolicy(.accessory)   // menu bar only, no Dock icon
app.run()
