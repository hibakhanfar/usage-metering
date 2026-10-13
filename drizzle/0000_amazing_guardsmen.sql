CREATE TYPE "public"."period_type" AS ENUM('month', 'day');--> statement-breakpoint
CREATE TYPE "public"."plan_kind" AS ENUM('account', 'user');--> statement-breakpoint
CREATE TYPE "public"."scope_type" AS ENUM('account', 'user');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"account_plan_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"kind" "plan_kind" NOT NULL,
	"name" text NOT NULL,
	"monthly_allowance" bigint,
	"daily_allowance" bigint,
	"max_per_request" bigint,
	"is_predefined" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_monthly_nonneg" CHECK ("plans"."monthly_allowance" IS NULL OR "plans"."monthly_allowance" >= 0),
	CONSTRAINT "plans_daily_nonneg" CHECK ("plans"."daily_allowance" IS NULL OR "plans"."daily_allowance" >= 0),
	CONSTRAINT "plans_max_nonneg" CHECK ("plans"."max_per_request" IS NULL OR "plans"."max_per_request" >= 0)
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"units" bigint NOT NULL,
	"accepted" boolean NOT NULL,
	"rejected_by" "scope_type",
	"rejected_rule" text,
	"violations" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"month" date NOT NULL,
	CONSTRAINT "requests_units_positive" CHECK ("requests"."units" > 0)
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid,
	"period_type" "period_type" NOT NULL,
	"period_start" date NOT NULL,
	"units_used" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_nonneg" CHECK ("usage_counters"."units_used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"user_plan_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_account_plan_id_plans_id_fk" FOREIGN KEY ("account_plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_user_plan_id_plans_id_fk" FOREIGN KEY ("user_plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_account_kind_name_uq" ON "plans" USING btree (coalesce("account_id", '00000000-0000-0000-0000-000000000000'),"kind","name");--> statement-breakpoint
CREATE UNIQUE INDEX "requests_account_request_uq" ON "requests" USING btree ("account_id","request_id");--> statement-breakpoint
CREATE INDEX "requests_account_created_idx" ON "requests" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "requests_user_created_idx" ON "requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_counter_uq" ON "usage_counters" USING btree ("account_id",coalesce("user_id", '00000000-0000-0000-0000-000000000000'),"period_type","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "users_account_external_uq" ON "users" USING btree ("account_id","external_id");