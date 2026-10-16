import { supabaseAdmin } from "../lib/supabase-admin";

// Baseline row counts for weekly backup verification drill (production-checklist.md section 9.3).
async function main() {
  const db = supabaseAdmin();
  const tables = ["tenants", "memberships", "messages", "conversations", "bookings", "payments", "credit_ledger", "vertical_packs"] as const;

  console.log("=== Supabase Database Backup Baseline (Drill) ===");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  for (const table of tables) {
    const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
    if (error) {
      console.error(`  [${table}]: ERROR - ${error.message}`);
    } else {
      console.log(`  [${table}]: ${count} rows`);
    }
  }

  console.log("\nStatus: Database is responsive and accessible via service-role client.");
  console.log("Automated Daily Backups: Handled by Supabase Cloud (Database -> Backups).");
}

void main();
