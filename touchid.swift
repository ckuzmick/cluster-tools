// Tiny Touch ID gate. Compile once (needs Xcode Command Line Tools):
//   swiftc -O touchid.swift -o touchid
// Exits 0 on success, 1 on failure/cancel. cluster.js runs it automatically
// if the compiled binary sits next to cluster.js.
import LocalAuthentication

let ctx = LAContext()
var err: NSError?
// .deviceOwnerAuthentication = Touch ID with password fallback
guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
    FileHandle.standardError.write("touchid: authentication unavailable\n".data(using: .utf8)!)
    exit(1)
}
let sem = DispatchSemaphore(value: 0)
var ok = false
ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "submit a cluster job") { success, _ in
    ok = success
    sem.signal()
}
sem.wait()
exit(ok ? 0 : 1)
