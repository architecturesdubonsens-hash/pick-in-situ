import RoomPlan
import Combine

@MainActor
final class CaptureSessionManager: NSObject, ObservableObject {

    // MARK: - State
    @Published var isCapturing = false
    @Published var instruction: String = ""
    @Published var capturedRoom: CapturedRoom?
    @Published var uploadState: UploadState = .idle

    enum UploadState {
        case idle, uploading(progress: Double), success(scanId: UUID), failure(Error)
    }

    // MARK: - RoomPlan objects
    let captureSession = RoomCaptureSession()
    private let roomBuilder = RoomBuilder(options: [.beautifyObjects])

    override init() {
        super.init()
        captureSession.delegate = self
    }

    // MARK: - Control

    func startCapture() {
        let config = RoomCaptureSession.Configuration()
        captureSession.run(configuration: config)
        isCapturing = true
        instruction = "Déplacez-vous lentement dans la pièce"
    }

    func stopCapture() {
        captureSession.stop()
        // Le résultat arrive via captureSession(_:didEndWith:error:)
    }
}

// MARK: - RoomCaptureSessionDelegate

extension CaptureSessionManager: RoomCaptureSessionDelegate {

    // Instruction guidée en temps réel (scanner trop proche, trop vite, etc.)
    nonisolated func captureSession(
        _ session: RoomCaptureSession,
        didProvide instruction: RoomCaptureSession.Instruction
    ) {
        let text: String
        switch instruction {
        case .moveCloseToWall:   text = "Approchez-vous d'un mur"
        case .moveAwayFromWall:  text = "Éloignez-vous du mur"
        case .slowDown:          text = "Ralentissez"
        case .turnOnLight:       text = "Allumez la lumière"
        case .normal:            text = ""
        case .lowLight:          text = "Faible luminosité — allumez la lumière"
        @unknown default:        text = ""
        }
        Task { @MainActor in self.instruction = text }
    }

    // Mise à jour incrémentale pendant le scan (optionnel — pour feedback visuel)
    nonisolated func captureSession(
        _ session: RoomCaptureSession,
        didUpdate room: CapturedRoom
    ) {
        // La RoomCaptureView affiche déjà le feedback AR en temps réel,
        // ici on pourrait mettre à jour un compteur de murs détectés, etc.
    }

    // Fin du scan — post-traitement via RoomBuilder
    nonisolated func captureSession(
        _ session: RoomCaptureSession,
        didEndWith data: CapturedRoomData,
        error: Error?
    ) {
        Task { @MainActor in
            self.isCapturing = false
            guard error == nil else {
                self.instruction = "Erreur de capture : \(error!.localizedDescription)"
                return
            }
            do {
                // RoomBuilder finalise les géométries (lissage, suppression artefacts)
                self.capturedRoom = try await self.roomBuilder.capturedRoom(from: data)
                self.instruction = "Scan terminé ✓"
            } catch {
                self.instruction = "Erreur de traitement : \(error.localizedDescription)"
            }
        }
    }
}
