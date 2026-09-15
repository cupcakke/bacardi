import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import type { SessionData } from "@/lib/nac/models";

export const sessions = pgTable("nac_sessions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  data: jsonb("data").$type<SessionData>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("nac_sessions_updated_idx").on(table.updatedAt)]);
