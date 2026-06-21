import SwiftUI

struct DashboardView: View {
    @State private var chantiers: [Chantier] = []
    @State private var showNewChantier = false
    @State private var showCapture = false
    @State private var selectedChantier: Chantier?

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "f1f5f9").ignoresSafeArea()

                if chantiers.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .navigationTitle("Pick In Situ")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: { showNewChantier = true }) {
                        Label("Nouveau", systemImage: "plus")
                    }
                    .tint(Color(hex: "F97316"))
                }
            }
            .sheet(isPresented: $showNewChantier) {
                NewChantierSheet { chantier in
                    chantiers.append(chantier)
                    selectedChantier = chantier
                    showCapture = true
                }
            }
            .navigationDestination(isPresented: $showCapture) {
                if let chantier = selectedChantier {
                    CaptureView(chantier: chantier)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "lidar.measurement")
                .font(.system(size: 56))
                .foregroundStyle(Color(hex: "1e3a5f").opacity(0.3))
            Text("Aucun chantier")
                .font(.title3).fontWeight(.semibold)
                .foregroundStyle(Color(hex: "1e3a5f"))
            Text("Appuyez sur + pour créer votre premier relevé LiDAR")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }

    private var list: some View {
        List {
            ForEach(chantiers) { chantier in
                NavigationLink(destination: CaptureView(chantier: chantier)) {
                    ChantierRowView(chantier: chantier)
                }
                .listRowBackground(Color.white)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
    }
}

struct ChantierRowView: View {
    let chantier: Chantier

    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(hex: "1e3a5f"))
                .frame(width: 44, height: 44)
                .overlay {
                    Text(String(chantier.nom.prefix(1)))
                        .font(.headline).foregroundStyle(.white)
                }

            VStack(alignment: .leading, spacing: 3) {
                Text(chantier.nom)
                    .font(.subheadline).fontWeight(.semibold)
                Text(chantier.adresse)
                    .font(.caption).foregroundStyle(.secondary)
                Text("\(chantier.scans.count) scan\(chantier.scans.count > 1 ? "s" : "")")
                    .font(.caption2).foregroundStyle(Color(hex: "F97316"))
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption).foregroundStyle(.tertiary)
        }
        .padding(12)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }
}

struct NewChantierSheet: View {
    let onCreated: (Chantier) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var nom = ""
    @State private var adresse = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Informations") {
                    TextField("Nom du chantier", text: $nom)
                    TextField("Adresse", text: $adresse)
                }
            }
            .navigationTitle("Nouveau chantier")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Annuler") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Créer") {
                        onCreated(Chantier(nom: nom, adresse: adresse))
                        dismiss()
                    }
                    .disabled(nom.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

// Utilitaire Color hex
extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let r = Double((int >> 16) & 0xFF) / 255
        let g = Double((int >> 8) & 0xFF) / 255
        let b = Double(int & 0xFF) / 255
        self.init(red: r, green: g, blue: b)
    }
}
