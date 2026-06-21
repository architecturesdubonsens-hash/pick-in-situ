import SwiftUI
import RoomPlan

struct CaptureResultView: View {
    let chantier: Chantier
    let capturedRoom: CapturedRoom
    @ObservedObject var manager: CaptureSessionManager

    @State private var nomScan = ""
    @Environment(\.dismiss) private var dismiss

    private var stats: (murs: Int, portes: Int, fenetres: Int, objets: Int) {
        (
            capturedRoom.walls.count,
            capturedRoom.doors.count,
            capturedRoom.windows.count,
            capturedRoom.objects.count
        )
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                // Résumé du scan
                statsCard

                // Nom du scan
                VStack(alignment: .leading, spacing: 8) {
                    Text("Nom du scan").font(.caption).foregroundStyle(.secondary)
                    TextField("Ex: RDC salon-cuisine", text: $nomScan)
                        .textFieldStyle(.roundedBorder)
                }
                .padding(.horizontal)

                // Bouton upload
                uploadButton
            }
            .padding(.top)
        }
        .navigationTitle("Résultat du scan")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { nomScan = "Scan \(DateFormatter.shortDate.string(from: Date()))" }
    }

    private var statsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Éléments détectés")
                .font(.headline).foregroundStyle(Color(hex: "1e3a5f"))

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                StatCell(label: "Murs", value: "\(stats.murs)", color: "1e3a5f", icon: "square.3.layers.3d")
                StatCell(label: "Portes", value: "\(stats.portes)", color: "F97316", icon: "door.right.hand.open")
                StatCell(label: "Fenêtres", value: "\(stats.fenetres)", color: "3b82f6", icon: "window.ceiling")
                StatCell(label: "Mobilier", value: "\(stats.objets)", color: "64748b", icon: "sofa")
            }
        }
        .padding()
        .background(Color.white, in: RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
        .padding(.horizontal)
    }

    @ViewBuilder
    private var uploadButton: some View {
        switch manager.uploadState {
        case .idle:
            Button(action: upload) {
                Label("Envoyer sur le cloud", systemImage: "icloud.and.arrow.up")
                    .font(.headline).foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Color(hex: "F97316"), in: RoundedRectangle(cornerRadius: 12))
            }
            .padding(.horizontal)

        case .uploading(let progress):
            VStack(spacing: 8) {
                ProgressView(value: progress)
                    .tint(Color(hex: "F97316"))
                Text("Upload en cours… \(Int(progress * 100))%")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal)

        case .success:
            Label("Scan envoyé avec succès", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .padding()

        case .failure(let error):
            VStack(spacing: 8) {
                Label("Échec : \(error.localizedDescription)", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red).font(.caption)
                Button("Réessayer", action: upload)
                    .tint(Color(hex: "F97316"))
            }
            .padding(.horizontal)
        }
    }

    private func upload() {
        let scanId = UUID()
        let nomFinal = nomScan.trimmingCharacters(in: .whitespaces)
        Task {
            await SupabaseUploader.shared.upload(
                capturedRoom: capturedRoom,
                chantierId: chantier.id,
                scanId: scanId,
                nomScan: nomFinal,
                manager: manager
            )
        }
    }
}

struct StatCell: View {
    let label: String
    let value: String
    let color: String
    let icon: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(Color(hex: color))
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(value).font(.title2).fontWeight(.bold).foregroundStyle(Color(hex: color))
                Text(label).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(12)
        .background(Color(hex: color).opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }
}

extension DateFormatter {
    static let shortDate: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "dd/MM/yyyy HH:mm"
        return f
    }()
}
