import Foundation

enum Config {
    static let supabaseURL    = "https://ojoswtbarspntovtcfsh.supabase.co"
    static let supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9qb3N3dGJhcnNwbnRvdnRjZnNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5ODU0MjQsImV4cCI6MjA5MTU2MTQyNH0.dE3qTrb1_MdjHfUnmWth2uQA8sWgECHF3Fu0hPdQJsg"

    // Bucket Storage Pick In Situ (préfixé pis- pour isolation dans Forme1)
    static let storageBucket = "pis-scans"

    // Schéma Postgres dédié (séparé du schéma public de CapInSitu/Forme1)
    static let dbSchema = "pick_in_situ"

    static let roomPlanFormatVersion = "1.0"
}
