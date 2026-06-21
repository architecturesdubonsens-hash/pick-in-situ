import SwiftUI
import RoomPlan

struct CaptureView: View {
    let chantier: Chantier

    @StateObject private var manager = CaptureSessionManager()
    @State private var showResult = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            // Vue AR RoomPlan — affiche le scan en temps réel avec overlay 3D
            RoomCaptureViewRepresentable(session: manager.captureSession)
                .ignoresSafeArea()

            VStack {
                // Bandeau instruction
                if !manager.instruction.isEmpty {
                    Text(manager.instruction)
                        .font(.subheadline).fontWeight(.medium)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16).padding(.vertical, 8)
                        .background(.black.opacity(0.6), in: Capsule())
                        .padding(.top, 20)
                }

                Spacer()

                // Bouton stop / résultat
                if manager.isCapturing {
                    Button(action: manager.stopCapture) {
                        Label("Terminer le scan", systemImage: "stop.circle.fill")
                            .font(.headline)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 24).padding(.vertical, 14)
                            .background(Color(hex: "F97316"), in: Capsule())
                    }
                    .padding(.bottom, 40)
                } else if manager.capturedRoom != nil {
                    Button(action: { showResult = true }) {
                        Label("Voir les résultats", systemImage: "checkmark.circle.fill")
                            .font(.headline)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 24).padding(.vertical, 14)
                            .background(Color(hex: "1e3a5f"), in: Capsule())
                    }
                    .padding(.bottom, 40)
                }
            }
        }
        .navigationTitle(chantier.nom)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { manager.startCapture() }
        .onDisappear { if manager.isCapturing { manager.stopCapture() } }
        .navigationDestination(isPresented: $showResult) {
            if let room = manager.capturedRoom {
                CaptureResultView(
                    chantier: chantier,
                    capturedRoom: room,
                    manager: manager
                )
            }
        }
    }
}

// MARK: - UIViewRepresentable pour RoomCaptureView

struct RoomCaptureViewRepresentable: UIViewRepresentable {
    let session: RoomCaptureSession

    func makeUIView(context: Context) -> RoomCaptureView {
        RoomCaptureView(session: session)
    }

    func updateUIView(_ uiView: RoomCaptureView, context: Context) {}
}
