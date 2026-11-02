import Foundation
import CounterpartKit

// The printer MCP's own confirmation, answered on the Mac exactly as asked (PRD §5.5 "Answer on your Mac"). The form
// can use any primitive MCP elicitation allows (boolean, string or a choice, number, integer), each with its title and
// description. The schema, its checks and the answer are CounterpartKit's (`Project.PrintConfirmation`), shared with
// the phone; this file only holds what the person is typing.

/// The answer sent with `objects.answerPrintConfirmation`: `{action, content}`, a string, number or bool per field.
public typealias PrintConfirmationAnswer = PrintConfirmationResponse.Answer

/// What the person entered for one question. It belongs to that question only: a replacement starts again from the
/// printer's own defaults, and camera analysis never fills it in.
public struct PrintConfirmationDraft: Sendable, Equatable {
    public typealias Field = Project.PrintConfirmation.Field
    public let confirmationId: String
    /// Switches and choices, as values.
    public var values: [String: CounterpartKit.JSONValue] = [:]
    /// Text and numbers, as typed.
    public var text: [String: String] = [:]

    public init(_ question: Project.PrintConfirmation) {
        confirmationId = question.id
        for field in question.fields {
            switch (field.type, field.initialValue) {
            case (.number, .number(let number)?), (.integer, .number(let number)?): text[field.name] = Self.plain(number)
            case (.string, .string(let value)?) where field.enumValues == nil: text[field.name] = value
            case (_, let value?): values[field.name] = value
            default: break
            }
        }
    }

    /// The value for one field from what was entered, or nil when nothing (or nothing readable) was entered.
    public func value(_ field: Field) -> CounterpartKit.JSONValue? {
        switch field.type {
        case .boolean: return values[field.name]
        case .string where field.enumValues != nil: return values[field.name]
        case .string:
            let entry = (text[field.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return entry.isEmpty ? nil : .string(entry)
        case .number, .integer:
            let entry = (text[field.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return Double(entry).map(CounterpartKit.JSONValue.number)
        case .unknown: return nil
        }
    }

    /// Every field's value, for the shared checks and the answer.
    public func content(for question: Project.PrintConfirmation) -> [String: CounterpartKit.JSONValue] {
        question.fields.reduce(into: [:]) { result, field in if let value = value(field) { result[field.name] = value } }
    }

    /// Why what was entered for a field can't be sent, in words; nil when it can (or nothing was typed yet).
    public func problem(_ field: Field) -> String? {
        let typed = (text[field.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        switch field.type {
        case .unknown: return "This Mac can't show this question."
        case .boolean: return nil
        case .string where field.enumValues != nil: return nil
        case .string:
            guard !typed.isEmpty, let value = value(field), !field.accepts(value) else { return nil }
            if let minLength = field.minLength, typed.unicodeScalars.count < minLength { return "At least \(minLength) characters." }
            if let maxLength = field.maxLength, typed.unicodeScalars.count > maxLength { return "At most \(maxLength) characters." }
            switch field.format {
            case "email": return "An email address."
            case "uri": return "A web address, with its scheme (https://…)."
            case "date": return "A date, as 2026-11-01."
            case "date-time": return "A date and time, as 2026-11-01T10:00:00Z."
            default: return "Check this value."
            }
        case .number, .integer:
            guard !typed.isEmpty else { return nil }
            guard let number = Double(typed), number.isFinite else { return field.type == .integer ? "A whole number." : "A number." }
            if field.type == .integer, number.rounded() != number { return "A whole number." }
            if let minimum = field.minimum, number < minimum { return "At least \(Self.plain(minimum))." }
            if let maximum = field.maximum, number > maximum { return "At most \(Self.plain(maximum))." }
            return nil
        }
    }

    /// The accept answer, through the shared checks, or nil while it can't be sent: another question, expired, not
    /// answerable here, a required field empty or unticked, or a value out of its limits.
    public func answer(_ question: Project.PrintConfirmation, at nowMs: Double) -> PrintConfirmationAnswer? {
        guard question.id == confirmationId else { return nil }
        // What is sent is what shows: never a field whose entry can't be read (it would be left out, and a default sent
        // in its place), and never a required field that was emptied.
        for field in question.fields where field.type != .boolean && !(field.type == .string && field.enumValues != nil) {
            let typed = (text[field.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if problem(field) != nil || (typed.isEmpty && field.required) || (!typed.isEmpty && value(field) == nil) { return nil }
        }
        return question.response(confirmationId: question.id, action: .accept, content: content(for: question), atMs: nowMs)?.answer
    }

    public static func plain(_ number: Double) -> String {
        number == number.rounded() && abs(number) < 1e15 ? String(Int(number)) : String(number)
    }
}
