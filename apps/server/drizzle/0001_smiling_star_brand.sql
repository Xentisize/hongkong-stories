CREATE TABLE "ip_daily_caps" (
	"ip" text NOT NULL,
	"day" date NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 10) DEFAULT '0' NOT NULL,
	CONSTRAINT "ip_daily_caps_ip_day_pk" PRIMARY KEY("ip","day")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"ip" text NOT NULL,
	"budget" integer NOT NULL,
	"used_tokens" integer DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sessions_created_at_idx" ON "sessions" USING btree ("created_at");