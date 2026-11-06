import Foundation

/// Pairing failures in plain words: what happened, and the one thing to do about it.
public enum PairingWords {
    public static let expired = "That code expired. Show a new one on your Mac: click the Counterpart icon in the menu bar → Add a phone."
    public static let unreachable = "Your phone can’t reach your Mac. Are they on the same Wi-Fi, or is your VPN on?"

    public static func message(_ code: PairingError.Code) -> String {
        switch code {
        case .invalidInvitation: "That isn’t a Counterpart code. Point at the code in Counterpart on your Mac."
        case .expiredInvitation: expired
        case .unsupportedInvitation: "That code is from a newer Counterpart. Update the app on this phone, then scan it again."
        case .unauthorized: "Your Mac turned this phone down, or the code was already used. Show a new code on your Mac and scan it."
        case .forbidden: "Your Mac turned this phone down. Show a new code and scan it."
        case .rateLimited: "Too many tries. Wait a minute, then scan a new code from your Mac."
        case .certificateChanged: "This Mac looks different from last time. Connect again to be safe."
        case .certificate: "Your phone couldn’t check that this is your Mac. Show a new code on your Mac and scan it."
        case .wrongHost: "That code sent your phone somewhere else, so nothing was shared. Scan the code on your Mac again."
        case .network, .timeout: unreachable
        case .unavailable: "Your Mac is busy right now. Try again in a moment."
        case .secureStorage: "This phone couldn’t save the connection. Unlock it and try again."
        case .pairingRequired: "Connect this phone to your Mac again."
        case .pairingChanged: "Your Mac changed while this was running. Try again."
        case .invalidResponse: "Your Mac answered in a way this app doesn’t understand. Update Counterpart on both, then connect again."
        case .invalidDeviceName: "Give this phone a name between 1 and 80 characters."
        case .nearbyDenied: "Your Mac said no to this phone. If that was a mistake, try again and click Allow on your Mac."
        case .nearbyExpired: "That took too long, so nothing connected. Try again, then click Allow on your Mac."
        case .localNetwork: "Counterpart can’t look on your Wi-Fi. Turn on Local Network for Counterpart in Settings."
        case .cancelled: "Cancelled. Nothing changed."
        case .busy: "Still working on the last request. Try again in a moment."
        }
    }

    /// The message for a failed pairing attempt: an unreachable Mac adds the Local Network hint.
    public static func failure(_ error: Error) -> String {
        let code: PairingError.Code
        if let error = error as? PairingError { code = error.code }
        else if let error = error as? PairingLinkError { code = PairingError(error).code }
        else { return "Connecting didn’t finish. Show a new code on your Mac and scan it." }
        if code == .network || code == .timeout {
            return unreachable + " If your iPhone just asked about your Wi-Fi, tap Allow, then try again."
        }
        return message(code)
    }

    /// A refusal that means the Mac no longer accepts this phone's credential.
    public static func turnedAway(_ code: PairingError.Code) -> Bool { [.unauthorized, .forbidden, .pairingRequired].contains(code) }
}
