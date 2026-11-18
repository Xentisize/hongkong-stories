CREATE TABLE "factcheck_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"npc_id" text NOT NULL,
	"player_input" text DEFAULT '' NOT NULL,
	"reply" text NOT NULL,
	"verdict" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"cost_usd" numeric(14, 10) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"session" text,
	"npc" text,
	"tokens" integer,
	"cost_usd" numeric(14, 10) DEFAULT '0' NOT NULL,
	"latency_ms" double precision,
	"cached_tokens" integer,
	"rejected" text[],
	"path" text
);
--> statement-breakpoint
CREATE INDEX "factcheck_status_ts_idx" ON "factcheck_entries" USING btree ("status","ts");--> statement-breakpoint
CREATE INDEX "usage_events_ts_idx" ON "usage_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "usage_events_type_ts_idx" ON "usage_events" USING btree ("type","ts");