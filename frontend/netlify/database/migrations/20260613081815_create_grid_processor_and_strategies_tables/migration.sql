CREATE TABLE "grid_processor_leases" (
	"chain_id" integer PRIMARY KEY,
	"version" integer DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"lease" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grid_strategies" (
	"strategy_id" text PRIMARY KEY,
	"owner_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"pair_id" text NOT NULL,
	"status" text NOT NULL,
	"lower_price" double precision NOT NULL,
	"upper_price" double precision NOT NULL,
	"grid_mode" text NOT NULL,
	"grid_count" integer NOT NULL,
	"trade_size_quote" text NOT NULL,
	"trigger_price" double precision,
	"stop_loss_price" double precision,
	"take_profit_price" double precision,
	"max_slippage_bps" integer NOT NULL,
	"execution_interval_sec" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "grid_strategies_status_check" CHECK (status IN ('draft', 'funded', 'active', 'paused', 'gas_paused', 'archived', 'closed')),
	CONSTRAINT "grid_strategies_grid_mode_check" CHECK (grid_mode IN ('arithmetic', 'geometric'))
);
--> statement-breakpoint
CREATE INDEX "grid_processor_leases_state_idx" ON "grid_processor_leases" ("state");--> statement-breakpoint
CREATE INDEX "grid_processor_leases_updated_at_idx" ON "grid_processor_leases" ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "grid_strategies_chain_status_idx" ON "grid_strategies" ("chain_id","status");--> statement-breakpoint
CREATE INDEX "grid_strategies_owner_chain_idx" ON "grid_strategies" ("owner_address","chain_id");--> statement-breakpoint
CREATE INDEX "grid_strategies_active_idx" ON "grid_strategies" ("chain_id","strategy_id") WHERE status = 'active';