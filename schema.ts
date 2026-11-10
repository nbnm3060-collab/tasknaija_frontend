import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  uuid,
  uniqueIndex,
  check,
  index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
export const users = pgTable('users', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  phone: text().notNull().default(''),
  suspended: boolean().notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    plan: text().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    paymentReference: text('payment_reference').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('subscription_user_date').on(t.userId, t.createdAt),
    check(
      'subscription_plan_valid',
      sql`${t.plan} IN ('Basic','Standard','Premium')`,
    ),
  ],
)
export const tasks = pgTable(
  'tasks',
  {
    id: uuid().defaultRandom().primaryKey(),
    title: text().notNull(),
    description: text().notNull(),
    instructions: text().notNull(),
    category: text().notNull(),
    reward: integer().notNull(),
    difficulty: text().notNull(),
    active: boolean().notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('task_reward_positive', sql`${t.reward} > 0`),
    check(
      'task_category_valid',
      sql`${t.category} IN ('Basic','Standard','Premium')`,
    ),
  ],
)
export const submissions = pgTable(
  'task_submissions',
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    proof: text().notNull(),
    reward: integer().notNull(),
    status: text().notNull().default('Pending'),
    reviewNote: text('review_note'),
    reviewedBy: text('reviewed_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('one_submission_per_task').on(t.userId, t.taskId),
    check('submission_reward_positive', sql`${t.reward} > 0`),
    check(
      'submission_status_valid',
      sql`${t.status} IN ('Pending','Approved','Rejected')`,
    ),
  ],
)
export const wallets = pgTable(
  'wallets',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id),
    balance: integer().notNull().default(0),
  },
  (t) => [check('wallet_balance_nonnegative', sql`${t.balance} >= 0`)],
)
export const transactions = pgTable(
  'wallet_transactions',
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    amount: integer().notNull(),
    kind: text().notNull(),
    reference: text().notNull().unique(),
    description: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('ledger_user_date').on(t.userId, t.createdAt),
    check(
      'ledger_kind_amount_valid',
      sql`(${t.kind} = 'Task reward' AND ${t.amount} > 0) OR (${t.kind} = 'Withdrawal' AND ${t.amount} < 0)`,
    ),
  ],
)
export const withdrawals = pgTable(
  'withdrawals',
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    amount: integer().notNull(),
    bankName: text('bank_name').notNull(),
    accountNumber: text('account_number').notNull(),
    accountName: text('account_name').notNull(),
    status: text().notNull().default('Pending'),
    reviewNote: text('review_note'),
    reviewedBy: text('reviewed_by'),
    transferReference: text('transfer_reference').unique(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('withdrawal_user_status').on(t.userId, t.status),
    check('withdrawal_minimum', sql`${t.amount} >= 100000`),
    check(
      'withdrawal_status_valid',
      sql`${t.status} IN ('Pending','Approved','Rejected','Paid')`,
    ),
    check(
      'paid_transfer_reference_required',
      sql`${t.status} <> 'Paid' OR ${t.transferReference} IS NOT NULL`,
    ),
  ],
)
export const payments = pgTable(
  'payments',
  {
    reference: text().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    plan: text().notNull(),
    amount: integer().notNull(),
    status: text().notNull().default('Pending'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('payment_user_date').on(t.userId, t.createdAt),
    check(
      'payment_plan_price_valid',
      sql`(${t.plan} = 'Basic' AND ${t.amount} = 15000) OR (${t.plan} = 'Standard' AND ${t.amount} = 30000) OR (${t.plan} = 'Premium' AND ${t.amount} = 50000)`,
    ),
  ],
)
export const limits = pgTable('rate_limits', {
  key: text().primaryKey(),
  count: integer().notNull().default(1),
  resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
})
export const tickets = pgTable('support_tickets', {
  id: uuid().defaultRandom().primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  subject: text().notNull(),
  message: text().notNull(),
  reply: text(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})
export const audit = pgTable('admin_audit', {
  id: uuid().defaultRandom().primaryKey(),
  adminId: text('admin_id').notNull(),
  action: text().notNull(),
  targetId: text('target_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})
