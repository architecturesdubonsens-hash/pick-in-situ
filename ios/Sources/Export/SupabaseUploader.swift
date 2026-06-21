import Foundation
import RoomPlan

// Upload vers Supabase Storage via l'API REST (pas de SDK Swift requis).
// Séquence : sérialisation JSON + export USDZ → upload en parallèle → insert DB.
actor SupabaseUploader {
    static let shared = SupabaseUploader()

    private let session = URLSession.shared

    func upload(
        capturedRoom: CapturedRoom,
        chantierId: UUID,
        scanId: UUID,
        nomScan: String,
        manager: CaptureSessionManager
    ) async {
        await MainActor.run { manager.uploadState = .uploading(progress: 0) }

        do {
            // 1. Sérialiser roomplan.json
            let jsonData = try RoomPlanSerializer.serialize(capturedRoom)
            await MainActor.run { manager.uploadState = .uploading(progress: 0.2) }

            // 2. Exporter le mesh USDZ dans un fichier temporaire
            let usdzURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(scanId.uuidString).usdz")
            try capturedRoom.export(to: usdzURL, exportOptions: .mesh)
            let usdzData = try Data(contentsOf: usdzURL)
            await MainActor.run { manager.uploadState = .uploading(progress: 0.4) }

            // 3. Upload JSON → Supabase Storage
            let jsonPath = "\(chantierId)/\(scanId)/roomplan.json"
            try await uploadFile(data: jsonData, path: jsonPath, contentType: "application/json")
            await MainActor.run { manager.uploadState = .uploading(progress: 0.65) }

            // 4. Upload USDZ → Supabase Storage
            let usdzPath = "\(chantierId)/\(scanId)/mesh.usdz"
            try await uploadFile(data: usdzData, path: usdzPath, contentType: "model/vnd.usdz+zip")
            try? FileManager.default.removeItem(at: usdzURL)
            await MainActor.run { manager.uploadState = .uploading(progress: 0.85) }

            // 5. Créer l'enregistrement en base
            try await insertScanRecord(
                chantierId: chantierId,
                scanId: scanId,
                nomScan: nomScan,
                jsonPath: jsonPath,
                usdzPath: usdzPath
            )

            await MainActor.run { manager.uploadState = .success(scanId: scanId) }

        } catch {
            await MainActor.run { manager.uploadState = .failure(error) }
        }
    }

    // MARK: - Supabase Storage upload

    private func uploadFile(data: Data, path: String, contentType: String) async throws {
        let url = URL(string: "\(Config.supabaseURL)/storage/v1/object/\(Config.storageBucket)/\(path)")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(Config.supabaseAnonKey)", forHTTPHeaderField: "Authorization")
        req.setValue(Config.supabaseAnonKey, forHTTPHeaderField: "apikey")
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        req.httpBody = data

        let (_, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw UploadError.httpError((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
    }

    // MARK: - Supabase DB insert (table "scans")

    private func insertScanRecord(
        chantierId: UUID,
        scanId: UUID,
        nomScan: String,
        jsonPath: String,
        usdzPath: String
    ) async throws {
        let url = URL(string: "\(Config.supabaseURL)/rest/v1/scans")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(Config.supabaseAnonKey)", forHTTPHeaderField: "Authorization")
        req.setValue(Config.supabaseAnonKey, forHTTPHeaderField: "apikey")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("return=minimal", forHTTPHeaderField: "Prefer")
        // Cibler le schéma pick_in_situ, pas public
        req.setValue(Config.dbSchema, forHTTPHeaderField: "Content-Profile")

        let body: [String: Any] = [
            "id": scanId.uuidString,
            "chantier_id": chantierId.uuidString,
            "nom": nomScan,
            "status": "ready",
            "roomplan_path": jsonPath,
            "mesh_path": usdzPath,
            "captured_at": ISO8601DateFormatter().string(from: Date())
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw UploadError.httpError((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
    }

    enum UploadError: LocalizedError {
        case httpError(Int)
        var errorDescription: String? {
            switch self { case .httpError(let code): return "Erreur HTTP \(code)" }
        }
    }
}
