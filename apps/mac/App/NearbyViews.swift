import SwiftUI
#if canImport(ControlKit)
import ControlKit
#endif

private let clay = Color(red:0.77, green:0.32, blue:0.17)

extension NearbyModel {
    static let shared = NearbyModel(companion:SocketNearby(path:ModelAccessModel.socketPath(for:Installation(bundle:.main))))
}

/// "David's iPhone wants to connect · 482 913" with Don't Allow and Allow, at the top of the popover
/// (journey.md §3.4 and M1, mockup 08). The QR window stays QR-only.
struct NearbyRequestCard: View {
    let request: ControlNearbyRequest
    @ObservedObject var model: NearbyModel
    private var busy: Bool { model.answering.contains(request.id) }

    var body: some View {
        VStack(alignment:.trailing, spacing:7) {
            HStack(spacing:9) {
                Image(systemName:"iphone")
                    .font(.system(size:14))
                    .foregroundStyle(clay)
                    .frame(width:28, height:28)
                    .background(RoundedRectangle(cornerRadius:7).fill(clay.opacity(0.14)))
                (Text("\(request.deviceName) wants to connect · ") + Text(NearbyModel.format(request.code)).fontWeight(.semibold).monospacedDigit())
                    .font(.system(size:12.5))
                    .frame(maxWidth:.infinity, alignment:.leading)
            }
            HStack(spacing:6) {
                Button("Don't Allow") { Task { await model.answer(request, allow:false) } }
                Button("Allow") { Task { await model.answer(request, allow:true) } }
                    .keyboardShortcut(.defaultAction)
            }
            .controlSize(.small)
            .disabled(busy)
            if let problem = model.problem, problem.requestID == request.id {
                Text(problem.text).font(.system(size:11.5)).foregroundStyle(.secondary)
                    .frame(maxWidth:.infinity, alignment:.leading)
            }
        }
        .padding(EdgeInsets(top:9, leading:10, bottom:9, trailing:10))
        .background(RoundedRectangle(cornerRadius:12).fill(Color(nsColor:.controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius:12).strokeBorder(Color.primary.opacity(0.1)))
    }
}
