import Foundation

/// Size, time and grams, written the same way on every screen and device.
public enum Format {
    /// "48 × 50 × 54 mm": whole millimetres, because LiDAR isn't sub-millimetre.
    public static func size(_ millimetres: [Double]?) -> String? {
        guard let millimetres, millimetres.count == 3, millimetres.allSatisfy({ $0.isFinite && $0 >= 0 }) else { return nil }
        return millimetres.map { String(Int($0.rounded())) }.joined(separator: " × ") + " mm"
    }

    /// A print or work duration: "45 s", "38 min", "1 h 12 m", "3 h".
    public static func duration(_ seconds: Double?) -> String? {
        guard let seconds, seconds.isFinite, seconds >= 0 else { return nil }
        if seconds < 60 { return "\(Int(seconds.rounded())) s" }
        let minutes = Int((seconds / 60).rounded())
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60, rest = minutes % 60
        return rest == 0 ? "\(hours) h" : "\(hours) h \(rest) m"
    }

    /// "about 4 min", for an estimate; under a minute is "less than a minute".
    public static func about(_ seconds: Double?) -> String? {
        guard let seconds, seconds.isFinite, seconds >= 0 else { return nil }
        if seconds < 60 { return "less than a minute" }
        return "about " + (duration(seconds) ?? "")
    }

    /// "22 g": whole grams, or one decimal under 10 g.
    public static func grams(_ grams: Double?) -> String? {
        guard let grams, grams.isFinite, grams >= 0 else { return nil }
        return grams < 10 ? String(format: "%.1f g", grams) : "\(Int(grams.rounded())) g"
    }

    /// "42%"
    public static func percent(_ value: Double?) -> String? {
        guard let value, value.isFinite else { return nil }
        return "\(Int(min(100, max(0, value)).rounded(.down)))%"
    }

    /// "220 °C"
    public static func temperature(_ celsius: Double?) -> String? {
        guard let celsius, celsius.isFinite else { return nil }
        return "\(Int(celsius.rounded())) °C"
    }

    /// When something happened, as a card shows it: "Now", "2 min ago", "3 h ago", "Yesterday", "Oct 30".
    public static func when(_ date: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "Now" }
        if seconds < 3600 { return "\(Int(seconds / 60)) min ago" }
        if calendar.isDate(date, inSameDayAs: now) { return "\(Int(seconds / 3600)) h ago" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
        let style = Date.FormatStyle(locale: locale, calendar: calendar).month(.abbreviated).day()
        return date.formatted(style)
    }

    /// `when` mid-sentence: "Printed just now", "Printed yesterday", "Printed Oct 30".
    public static func whenInSentence(_ date: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        switch when(date, now: now, calendar: calendar, locale: locale) {
        case "Now": "just now"
        case "Yesterday": "yesterday"
        case let words: words
        }
    }

    /// "1:24 PM": the time of day something will finish.
    public static func clock(_ date: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        var style = Date.FormatStyle(locale: locale).hour().minute()
        style.timeZone = timeZone
        return date.formatted(style)
    }

    /// "Updated 3 s ago", for a refreshing photo.
    public static func updated(_ date: Date, now: Date = Date()) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        if seconds < 60 { return "Updated \(seconds) s ago" }
        return "Updated \(seconds / 60) min ago"
    }

    /// "3 s ago", short, for an overlay.
    public static func ago(_ date: Date, now: Date = Date()) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        return seconds < 60 ? "\(seconds) s ago" : "\(seconds / 60) min ago"
    }
}
