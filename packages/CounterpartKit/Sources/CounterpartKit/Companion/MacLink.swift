import Foundation

/// Whether the paired Mac is answering, as one value the whole phone app reads. It replaces a `reachable: Bool?` kept
/// beside the last load's error: Home read one and Settings read both, so after a request the Mac answered with a
/// refusal Home said "connected" while Settings said "Can't reach it right now".
///
/// Every reply from the Mac, even a refusal, is an answer. Only two failures are about the connection: the Mac
/// didn't answer, or it wants the phone paired again.
public enum MacLink: Equatable, Sendable {
    /// Nothing has come back yet (first launch, a new pairing).
    case checking
    case connected
    case notAnswering
    case needsPairing(CompanionError)

    /// The Mac replied.
    public mutating func answered() { self = .connected }

    /// A request failed. One the Mac refused for any other reason still proves it is there.
    public mutating func failed(_ error: CompanionError) {
        if error.needsPairing { self = .needsPairing(error) }
        else if error.isUnreachable { self = .notAnswering }
        else { self = .connected }
    }

    /// True once the Mac has answered, false when it didn't, nil while nothing is known (or pairing is the problem).
    public var reachable: Bool? {
        switch self {
        case .connected: true
        case .notAnswering: false
        case .checking, .needsPairing: nil
        }
    }

    /// What is wrong with the connection, for the banner; nil when nothing is.
    public var problem: CompanionError? {
        switch self {
        case .notAnswering: .unreachable
        case .needsPairing(let error): error
        case .checking, .connected: nil
        }
    }
}
