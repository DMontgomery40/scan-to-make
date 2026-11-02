import SwiftUI

// MARK: The printer MCP's own confirmation, rendered natively (PRD §5.5 behaviour, §9.3).
//
// bambu-printer-mcp asks this through MCP elicitation before every print
// (`confirmPrintPreflight`): one message, and a form with one boolean whose title is
// "I checked the printer and confirm this operation". The app shows the message's facts
// as rows and the boolean as a switch. Nothing goes to the printer until it's answered.

struct PrintConfirmSheet: View {
    @State private var checked = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(alignment: .top, spacing: 14) {
                        Image(systemName: "checkmark.shield.fill").font(.title2).foregroundStyle(.blue)
                            .frame(width: 52, height: 52).glassEffect(.regular.tint(.blue.opacity(0.25)), in: .circle)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("P1S needs a yes before printing Mic mount").font(.title3.bold()).fixedSize(horizontal: false, vertical: true)
                            Text("Asked by bambu-printer-mcp on Mac mini").font(.footnote).foregroundStyle(.secondary)
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Text("Start a checked print on P1S?").font(.headline)
                        FactRow(symbol: "circle.circle", label: "Nozzle", value: "0.4 mm")
                        FactRow(symbol: "cylinder.fill", label: "Material", value: "PLA")
                        FactRow(symbol: "flame.fill", label: "Peak", value: "Nozzle 220 °C · bed 55 °C")
                        FactRow(symbol: "doc.fill", label: "File", value: "mic-mount.3mf · 4f9c…e21a")
                        DisclosureGroup("Full message") {
                            Text("Start a checked print on P1S (01P00A451200123)? Nozzles: 0.4 mm. Materials: PLA. Peak targets: nozzle 220°C, bed 55°C, chamber 0°C. File SHA-256: 4f9c…e21a. Confirm the physical spool labels and that the build plate is clear.")
                                .font(.caption.monospaced()).foregroundStyle(.secondary).padding(.top, 6)
                        }
                        .font(.footnote).foregroundStyle(.secondary)
                    }
                    .padding(16)
                    .glassEffect(.regular, in: .rect(cornerRadius: 24))

                    VStack(alignment: .leading, spacing: 10) {
                        Text("Check at the printer").font(.headline)
                        Label("The spool labels match PLA", systemImage: "tag.fill")
                        Label("The build plate is clear", systemImage: "square.dashed")
                    }
                    .font(.subheadline)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .glassEffect(.regular.tint(.orange.opacity(0.12)), in: .rect(cornerRadius: 24))

                    Toggle(isOn: $checked) {
                        Text("I checked the printer and confirm this operation").font(.body.weight(.medium))
                    }
                    .padding(16)
                    .glassEffect(.regular, in: .rect(cornerRadius: 24))
                }
                .padding(20)
                .padding(.bottom, 100)
            }
            .navigationTitle("Confirm Print")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(role: .close) { } } }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    Button { } label: { Text("Start Print").fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 44) }
                        .buttonStyle(.glassProminent).controlSize(.large)
                        .disabled(!checked)
                    Text("Nothing goes to the printer until you confirm · 9:32 left")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 20)
            }
        }
    }
}

struct FactRow: View {
    let symbol: String, label: String, value: String
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 22)
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.subheadline.weight(.medium).monospacedDigit()).multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
    }
}

// MARK: Fallback: a question the app can't render (PRD §5.5)

struct AnswerOnMacSheet: View {
    var body: some View {
        VStack(spacing: 0) {
            Image(systemName: "macmini.fill").font(.system(size: 30)).foregroundStyle(.white)
                .frame(width: 72, height: 72).glassEffect(.regular.tint(.blue.opacity(0.3)), in: .circle)
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: "questionmark").font(.caption.weight(.heavy)).foregroundStyle(.white)
                        .frame(width: 26, height: 26).background(.orange, in: .circle).offset(x: 4, y: 4)
                }
                .padding(.top, 30)
            Text("P1S has a question for you").font(.title2.bold()).padding(.top, 18)
            Text("bambu-printer-mcp needs an answer before it prints Mic mount, and this app can't show that kind of question yet.")
                .font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                .padding(.top, 8).padding(.horizontal, 28)

            HStack(spacing: 12) {
                Image(systemName: "clock").foregroundStyle(.secondary)
                Text("Waiting on Mac mini").font(.subheadline)
                Spacer()
                Text("9:32").font(.subheadline.monospacedDigit().weight(.semibold)).foregroundStyle(.orange)
            }
            .padding(14)
            .glassEffect(.regular, in: .rect(cornerRadius: 20))
            .padding(.horizontal, 20).padding(.top, 22)

            Spacer(minLength: 16)
            GlassEffectContainer(spacing: 10) {
                VStack(spacing: 10) {
                    Button { } label: { Label("Answer on your Mac", systemImage: "macmini").fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 44) }
                        .buttonStyle(.glassProminent)
                    Button(role: .destructive) { } label: { Text("Don't Print").frame(maxWidth: .infinity).frame(height: 44) }
                        .buttonStyle(.glass)
                }
                .controlSize(.large)
            }
            .padding(.horizontal, 20)
            Text("Nothing is sent to the printer until someone answers.").font(.caption).foregroundStyle(.secondary).padding(.top, 10).padding(.bottom, 12)
        }
        .presentationDetents([.fraction(0.72)])
    }
}
