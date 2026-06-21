import RoomPlan
import simd
import Foundation

// Sérialise un CapturedRoom vers le format JSON attendu par le viewer web.
// Format : roomplan.json v1.0 (Pick In Situ)
struct RoomPlanSerializer {

    static func serialize(_ room: CapturedRoom) throws -> Data {
        let payload = buildPayload(room)
        return try JSONEncoder().encode(payload)
    }

    // MARK: - Construction du payload

    private static func buildPayload(_ room: CapturedRoom) -> RoomPlanPayload {
        let walls = room.walls.map { surfaceToWall($0) }
        let openings: [OpeningPayload] = []
            + room.doors.map { openingPayload($0, type: "door") }
            + room.windows.map { openingPayload($0, type: "window") }
            + room.openings.map { openingPayload($0, type: "opening") }

        let objects = room.objects.map { objectPayload($0) }

        let section = SectionPayload(
            id: UUID().uuidString,
            walls: walls,
            openings: openings,
            objects: objects
        )

        return RoomPlanPayload(
            version: Config.roomPlanFormatVersion,
            captureDate: ISO8601DateFormatter().string(from: Date()),
            sections: [section]
        )
    }

    // MARK: - Surfaces → murs

    private static func surfaceToWall(_ surface: CapturedRoom.Surface) -> WallPayload {
        WallPayload(
            id: surface.identifier.uuidString,
            transform: flattenTransform(surface.transform),
            dimensions: DimensionsPayload(
                width: Double(surface.dimensions.x),
                height: Double(surface.dimensions.y),
                length: Double(surface.dimensions.z)
            ),
            confidence: confidenceString(surface.confidence)
        )
    }

    // MARK: - Surfaces → ouvertures (portes, fenêtres)

    private static func openingPayload(_ surface: CapturedRoom.Surface, type: String) -> OpeningPayload {
        OpeningPayload(
            id: surface.identifier.uuidString,
            type: type,
            transform: flattenTransform(surface.transform),
            dimensions: OpeningDimensionsPayload(
                width: Double(surface.dimensions.x),
                height: Double(surface.dimensions.y)
            ),
            confidence: confidenceString(surface.confidence)
        )
    }

    // MARK: - Objets (mobilier)

    private static func objectPayload(_ object: CapturedRoom.Object) -> ObjectPayload {
        ObjectPayload(
            id: object.identifier.uuidString,
            category: object.category.rawValue,
            transform: flattenTransform(object.transform),
            dimensions: DimensionsPayload(
                width: Double(object.dimensions.x),
                height: Double(object.dimensions.y),
                length: Double(object.dimensions.z)
            ),
            confidence: confidenceString(object.confidence)
        )
    }

    // MARK: - Helpers

    // simd_float4x4 → tableau de 16 floats, colonne-major (même format que Polycam)
    private static func flattenTransform(_ t: simd_float4x4) -> [Double] {
        [
            Double(t.columns.0.x), Double(t.columns.0.y), Double(t.columns.0.z), Double(t.columns.0.w),
            Double(t.columns.1.x), Double(t.columns.1.y), Double(t.columns.1.z), Double(t.columns.1.w),
            Double(t.columns.2.x), Double(t.columns.2.y), Double(t.columns.2.z), Double(t.columns.2.w),
            Double(t.columns.3.x), Double(t.columns.3.y), Double(t.columns.3.z), Double(t.columns.3.w),
        ]
    }

    private static func confidenceString(_ c: CapturedRoom.Confidence) -> String {
        switch c {
        case .high:   return "high"
        case .medium: return "medium"
        case .low:    return "low"
        @unknown default: return "unknown"
        }
    }
}

// MARK: - Codable payload types (miroir du TypeScript côté web)

private struct RoomPlanPayload: Codable {
    let version: String
    let captureDate: String
    let sections: [SectionPayload]
}

private struct SectionPayload: Codable {
    let id: String
    let walls: [WallPayload]
    let openings: [OpeningPayload]
    let objects: [ObjectPayload]
}

private struct WallPayload: Codable {
    let id: String
    let transform: [Double]
    let dimensions: DimensionsPayload
    let confidence: String
}

private struct OpeningPayload: Codable {
    let id: String
    let type: String
    let transform: [Double]
    let dimensions: OpeningDimensionsPayload
    let confidence: String
}

private struct ObjectPayload: Codable {
    let id: String
    let category: String
    let transform: [Double]
    let dimensions: DimensionsPayload
    let confidence: String
}

private struct DimensionsPayload: Codable {
    let width: Double
    let height: Double
    let length: Double
}

private struct OpeningDimensionsPayload: Codable {
    let width: Double
    let height: Double
}
