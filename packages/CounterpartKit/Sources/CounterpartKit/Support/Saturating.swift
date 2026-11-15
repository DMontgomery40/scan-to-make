import Foundation

public extension Int {
    /// A whole number from a value that came from the companion or a sensor, never a trap (#840, David, Nov 15: "THE FACT
    /// THAT IT CAN CRASH THE APP AS OPPOSED TO SHOWING NOTHING"). `Int(Double)` traps on NaN, infinity and anything past
    /// `Int`'s range; this is 0 for NaN, and `Int.max`/`Int.min` past either end. It truncates toward zero, as `Int(_:)`.
    init(saturating value: Double) {
        if value.isNaN { self = 0 }
        else if value >= 9.223372036854775807e18 { self = .max }
        else if value <= -9.223372036854775808e18 { self = .min }
        else { self = Int(value) }
    }
}
