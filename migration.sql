ALTER TABLE "subscriptions" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "task_submissions" ADD CONSTRAINT "submission_reward_positive" CHECK ("reward" > 0);--> statement-breakpoint
ALTER TABLE "task_submissions" ADD CONSTRAINT "submission_status_valid" CHECK ("status" IN ('Pending','Approved','Rejected'));--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallet_balance_nonnegative" CHECK ("balance" >= 0);