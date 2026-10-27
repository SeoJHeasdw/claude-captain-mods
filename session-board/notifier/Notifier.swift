// Raises one macOS banner under this app's own name and icon, and opens the banner's link when
// it is clicked. The board runs it directly:
//
//   Notifier --title <title> --body <body> [--open <url>] [--wait <seconds>]
//
// Exit status: 0 posted; 2 banners are turned off for this app; 1 anything else, after which
// the board falls back to `osascript`. Launched with no title (by a click), it waits for the
// click's response, opens the link and leaves.

import AppKit
import UserNotifications

final class Delegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  let center = UNUserNotificationCenter.current()

  // The delegate must be in place before launching ends, or a click's response is not delivered.
  func applicationWillFinishLaunching(_ notification: Notification) {
    center.delegate = self
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let args = options(CommandLine.arguments)
    guard let title = args["--title"] else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 5) { exit(0) }
      return
    }
    // A permission prompt nobody answers must not hold the board; a setup run may wait longer.
    let patience = args["--wait"].flatMap(Double.init) ?? 8
    DispatchQueue.main.asyncAfter(deadline: .now() + patience) { exit(1) }
    center.getNotificationSettings { settings in
      switch settings.authorizationStatus {
      case .denied:
        exit(2)
      case .notDetermined:
        self.ask(title, args)
      default:
        // Allowed before the app asked for sound: asked again, so its sound switch appears.
        if settings.soundSetting == .notSupported {
          self.ask(title, args)
        } else {
          self.post(title, args)
        }
      }
    }
  }

  func ask(_ title: String, _ args: [String: String]) {
    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
      if granted {
        self.post(title, args)
      } else {
        if let error {
          FileHandle.standardError.write(Data("\(error)\n".utf8))
        }
        exit(error == nil ? 2 : 1)
      }
    }
  }

  // The app's own sound, where `build.sh` put one in its bundle; else the banner stays quiet.
  func post(_ title: String, _ args: [String: String]) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = args["--body"] ?? ""
    // Named by the bundle's copy, found by the system among ~/Library/Sounds, where `build.sh`
    // puts it under a name no other app's sound has.
    if let sound = Bundle.main.urls(forResourcesWithExtension: "wav", subdirectory: nil)?.first {
      content.sound = UNNotificationSound(named: UNNotificationSoundName(sound.lastPathComponent))
    }
    if let link = args["--open"] {
      content.userInfo = ["open": link]
    }
    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    center.add(request) { error in exit(error == nil ? 0 : 1) }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    done([.banner, .list])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler done: @escaping () -> Void
  ) {
    if let link = response.notification.request.content.userInfo["open"] as? String,
       let url = URL(string: link) {
      NSWorkspace.shared.open(url)
    }
    done()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(0) }
  }
}

/** `--name value` pairs; a name without a value is dropped. */
func options(_ argv: [String]) -> [String: String] {
  var found: [String: String] = [:]
  var index = 1
  while index + 1 < argv.count {
    if argv[index].hasPrefix("--") {
      found[argv[index]] = argv[index + 1]
      index += 2
    } else {
      index += 1
    }
  }
  return found
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
