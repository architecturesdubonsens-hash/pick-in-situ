import Foundation

struct Chantier: Identifiable, Codable {
    let id: UUID
    var nom: String
    var adresse: String
    var createdAt: Date
    var scans: [Scan]

    init(id: UUID = UUID(), nom: String, adresse: String) {
        self.id = id
        self.nom = nom
        self.adresse = adresse
        self.createdAt = Date()
        self.scans = []
    }
}

struct Scan: Identifiable, Codable {
    let id: UUID
    var chantierId: UUID
    var nom: String
    var capturedAt: Date
    var status: ScanStatus
    var artifacts: [Artifact]

    enum ScanStatus: String, Codable {
        case capturing, processing, ready, failed
    }
}

struct Artifact: Identifiable, Codable {
    let id: UUID
    var scanId: UUID
    var type: ArtifactType
    var storagePath: String   // chemin Supabase Storage
    var createdAt: Date

    enum ArtifactType: String, Codable {
        case roomplanJSON = "roomplan_json"
        case meshUSDZ = "mesh_usdz"
        case floorplanSVG = "floorplan_svg"
        case exportDXF = "export_dxf"
    }
}
