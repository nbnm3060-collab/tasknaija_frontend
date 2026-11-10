CREATE INDEX "payment_user_date" ON "payments" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "subscription_user_date" ON "subscriptions" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_user_date" ON "wallet_transactions" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "withdrawal_user_status" ON "withdrawals" ("user_id","status");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payment_plan_price_valid" CHECK (("plan" = 'Basic' AND "amount" = 15000) OR ("plan" = 'Standard' AND "amount" = 30000) OR ("plan" = 'Premium' AND "amount" = 50000));--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscription_plan_valid" CHECK ("plan" IN ('Basic','Standard','Premium'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "task_reward_positive" CHECK ("reward" > 0);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "task_category_valid" CHECK ("category" IN ('Basic','Standard','Premium'));--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "ledger_kind_amount_valid" CHECK (("kind" = 'Task reward' AND "amount" > 0) OR ("kind" = 'Withdrawal' AND "amount" < 0));--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawal_minimum" CHECK ("amount" >= 100000);--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawal_status_valid" CHECK ("status" IN ('Pending','Approved','Rejected','Paid'));--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "paid_transfer_reference_required" CHECK ("status" <> 'Paid' OR "transfer_reference" IS NOT NULL);