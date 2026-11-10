import type { Config, Context } from '@netlify/functions'
import {
  getUser,
  login,
  logout,
  signup,
  admin as identityAdmin,
  verifyRequestOrigin,
} from '@netlify/identity'
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { database } from '../../db/index'
import {
  users,
  wallets,
  tasks,
  submissions,
  subscriptions,
  transactions,
  withdrawals,
  payments,
  limits,
  tickets,
  audit,
} from '../../db/schema'

const planSchema = z.enum(['Basic', 'Standard', 'Premium'])
const prices = { Basic: 15000, Standard: 30000, Premium: 50000 }
const ranks = { Basic: 1, Standard: 2, Premium: 3 }
const uuid = z.string().uuid()
class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
function env(key: string) {
  return Netlify.env.get(key)
}
function fail(message: string, status = 400): never {
  throw new Problem(status, message)
}
async function rate(key: string, maximum: number, seconds: number) {
  const db = database()
  const hashed = createHash('sha256').update(key).digest('hex')
  const [r] = await db
    .insert(limits)
    .values({ key: hashed, resetAt: new Date(Date.now() + seconds * 1000) })
    .onConflictDoUpdate({
      target: limits.key,
      set: {
        count: sql`CASE WHEN ${limits.resetAt} < now() THEN 1 ELSE ${limits.count} + 1 END`,
        resetAt: sql`CASE WHEN ${limits.resetAt} < now() THEN now() + ${seconds} * interval '1 second' ELSE ${limits.resetAt} END`,
      },
    })
    .returning()
  if (r.count > maximum)
    fail(
      'Too many attempts. Please wait a few minutes before trying again.',
      429,
    )
}
async function paystack(path: string, body?: unknown) {
  const secret = env('PAYSTACK_SECRET_KEY')
  if (!secret)
    fail('Payments are not configured yet. Please contact support.', 503)
  const response = await fetch(`https://api.paystack.co${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  })
  const result = await response.json()
  if (!response.ok || !result.status)
    fail('Paystack could not complete this request. Please try again.', 502)
  return result.data
}
async function verifyPayment(reference: string, userId?: string) {
  const db = database()
  const [p] = await db
    .select()
    .from(payments)
    .where(eq(payments.reference, reference))
  if (!p || (userId && p.userId !== userId))
    fail('Payment record not found.', 404)
  const result = await paystack(
    `/transaction/verify/${encodeURIComponent(reference)}`,
  )
  const [owner] = await db.select().from(users).where(eq(users.id, p.userId))
  if (result.status !== 'success')
    fail(
      'Payment has not been confirmed by Paystack. You can check again shortly.',
    )
  if (
    result.reference !== p.reference ||
    result.currency !== 'NGN' ||
    Number(result.amount) !== p.amount ||
    result.customer?.email?.toLowerCase() !== owner.email.toLowerCase() ||
    result.metadata?.userId !== p.userId ||
    result.metadata?.plan !== p.plan
  )
    fail('Payment details do not match this subscription.', 409)
  await db.transaction(async (tx) => {
    await tx.select().from(users).where(eq(users.id, p.userId)).for('update')
    const [locked] = await tx
      .select()
      .from(payments)
      .where(eq(payments.reference, reference))
      .for('update')
    if (locked.status === 'Success') return
    const [previous] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, p.userId))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1)
    // Same-plan renewals extend the remaining time. A plan change begins a fresh 30 days.
    const start =
      previous?.plan === p.plan
        ? Math.max(Date.now(), previous.expiresAt.getTime())
        : Date.now()
    await tx.insert(subscriptions).values({
      userId: p.userId,
      plan: p.plan,
      paymentReference: reference,
      createdAt: new Date(),
      expiresAt: new Date(start + 30 * 86400000),
    })
    await tx
      .update(payments)
      .set({ status: 'Success' })
      .where(eq(payments.reference, reference))
  })
  return { message: 'Payment verified. Your subscription is active.' }
}
export default async (req: Request, context: Context) => {
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  try {
    const path = new URL(req.url).pathname.replace(/^\/api\/?/, '')
    const db = database()
    if (path === 'paystack-webhook') {
      if (req.method !== 'POST') fail('Method not allowed.', 405)
      const secret = env('PAYSTACK_SECRET_KEY')
      if (!secret) fail('Payments are unavailable.', 503)
      const raw = await req.text()
      const signature = req.headers.get('x-paystack-signature') || ''
      const expected = createHmac('sha512', secret).update(raw).digest('hex')
      if (
        !/^[a-f0-9]{128}$/i.test(signature) ||
        !timingSafeEqual(
          Buffer.from(signature, 'hex'),
          Buffer.from(expected, 'hex'),
        )
      )
        fail('Invalid webhook signature.', 401)
      const event = JSON.parse(raw)
      if (event.event === 'charge.success')
        await verifyPayment(z.string().max(100).parse(event.data.reference))
      return Response.json({ received: true }, { headers })
    }
    if (!['GET', 'POST'].includes(req.method)) fail('Method not allowed.', 405)
    if (req.method === 'POST') verifyRequestOrigin(req)
    if (Number(req.headers.get('content-length') || 0) > 30000)
      fail('Request is too large.', 413)
    const body = req.method === 'POST' ? await req.json() : {}
    const post = () => {
      if (req.method !== 'POST') fail('Method not allowed.', 405)
    }
    if (path === 'auth/register' || path === 'auth/login') {
      post()
      await rate(
        `${path}:${context.ip}`,
        path.endsWith('register') ? 15 : 40,
        900,
      )
      const common = z.object({
        email: z
          .email()
          .max(254)
          .transform((v) => v.trim().toLowerCase()),
        password: z.string().min(10).max(128),
      })
      if (path === 'auth/register') {
        const v = common
          .extend({
            name: z.string().trim().min(2).max(100),
            phone: z
              .string()
              .regex(
                /^(?:\+234|0)[789]\d{9}$/,
                'Enter a valid Nigerian mobile number.',
              ),
            confirmPassword: z.string(),
          })
          .refine((v) => v.password === v.confirmPassword, {
            message: 'Passwords do not match.',
          })
          .parse(body)
        const user = await signup(v.email, v.password, {
          full_name: v.name,
          phone: v.phone,
        })
        await db.transaction(async (tx) => {
          await tx
            .insert(users)
            .values({
              id: user.id,
              name: v.name,
              email: v.email,
              phone: v.phone,
            })
            .onConflictDoNothing()
          await tx
            .insert(wallets)
            .values({ userId: user.id })
            .onConflictDoNothing()
        })
        return Response.json(
          {
            message: user.confirmedAt
              ? 'Account created. You can now log in.'
              : 'Account created. Check your email to confirm your account, then log in.',
          },
          { headers },
        )
      }
      const v = common.parse(body)
      await rate(`login:${v.email}`, 25, 900)
      try {
        await login(v.email, v.password)
      } catch {
        fail(
          'Unable to log in. Check your email, password, and account confirmation.',
          401,
        )
      }
      return Response.json({ message: 'Welcome back.' }, { headers })
    }
    if (path === 'auth/logout') {
      post()
      await logout()
      return Response.json({ message: 'Signed out.' }, { headers })
    }
    const identity = await getUser()
    if (!identity?.email) fail('Please log in to continue.', 401)
    const email = identity.email.toLowerCase()
    await db
      .insert(users)
      .values({
        id: identity.id,
        email,
        name: identity.name || email.split('@')[0],
        phone: String(identity.userMetadata?.phone || ''),
      })
      .onConflictDoUpdate({
        target: users.id,
        set: { email, name: identity.name || email.split('@')[0] },
      })
    await db
      .insert(wallets)
      .values({ userId: identity.id })
      .onConflictDoNothing()
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, identity.id))
    if (user.suspended)
      fail('Your account is suspended. Contact support for a review.', 403)
    let isAdmin = false
    if (email === env('ADMIN_EMAIL')?.trim().toLowerCase()) {
      // Read the authoritative Identity account; never trust editable profile metadata or an unverified email.
      const confirmed = await identityAdmin.getUser(identity.id)
      isAdmin = Boolean(
        confirmed.confirmedAt && confirmed.email?.toLowerCase() === email,
      )
    }
    const [subscription] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, user.id))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1)
    const active = Boolean(
      subscription && subscription.expiresAt.getTime() > Date.now(),
    )
    if (path === 'me')
      return Response.json(
        {
          user: { ...user, isAdmin },
          paymentsEnabled: Boolean(env('PAYSTACK_SECRET_KEY')),
          subscription: subscription ? { ...subscription, active } : null,
        },
        { headers },
      )
    if (path === 'overview') {
      const [wallet] = await db
        .select()
        .from(wallets)
        .where(eq(wallets.userId, user.id))
      const mySubmissions = await db
        .select({
          id: submissions.id,
          title: tasks.title,
          status: submissions.status,
          reward: submissions.reward,
          proof: submissions.proof,
          reviewNote: submissions.reviewNote,
          createdAt: submissions.createdAt,
        })
        .from(submissions)
        .innerJoin(tasks, eq(tasks.id, submissions.taskId))
        .where(eq(submissions.userId, user.id))
        .orderBy(desc(submissions.createdAt))
      const ledger = await db
        .select()
        .from(transactions)
        .where(eq(transactions.userId, user.id))
        .orderBy(desc(transactions.createdAt))
      const requests = await db
        .select()
        .from(withdrawals)
        .where(eq(withdrawals.userId, user.id))
        .orderBy(desc(withdrawals.createdAt))
      const paymentRecords = await db
        .select()
        .from(payments)
        .where(eq(payments.userId, user.id))
        .orderBy(desc(payments.createdAt))
      const availableTasks = active
        ? (
            await db
              .select({
                id: tasks.id,
                title: tasks.title,
                category: tasks.category,
                reward: tasks.reward,
              })
              .from(tasks)
              .where(
                and(
                  eq(tasks.active, true),
                  sql`${tasks.id} NOT IN (SELECT task_id FROM task_submissions WHERE user_id = ${user.id})`,
                ),
              )
          ).filter(
            (t) =>
              ranks[t.category as keyof typeof ranks] <=
              ranks[subscription.plan as keyof typeof ranks],
          )
        : []
      const reserved = requests
        .filter((w) => ['Pending', 'Approved'].includes(w.status))
        .reduce((a, w) => a + w.amount, 0)
      return Response.json(
        {
          wallet,
          availableTasks,
          submissions: mySubmissions,
          transactions: ledger,
          withdrawals: requests,
          payments: paymentRecords,
          reserved,
          totalEarned: ledger
            .filter((t) => t.amount > 0)
            .reduce((a, t) => a + t.amount, 0),
        },
        { headers },
      )
    }
    if (path === 'tasks') {
      if (!active) fail('Choose an active subscription to access tasks.', 402)
      const list = await db
        .select()
        .from(tasks)
        .where(eq(tasks.active, true))
        .orderBy(desc(tasks.createdAt))
      const submitted = await db
        .select({ taskId: submissions.taskId, status: submissions.status })
        .from(submissions)
        .where(eq(submissions.userId, user.id))
      return Response.json(
        list
          .filter(
            (t) =>
              ranks[t.category as keyof typeof ranks] <=
              ranks[subscription.plan as keyof typeof ranks],
          )
          .map((t) => ({
            ...t,
            submissionStatus: submitted.find((s) => s.taskId === t.id)?.status,
          })),
        { headers },
      )
    }
    if (path === 'submit') {
      post()
      await rate(`submit:${user.id}`, 40, 3600)
      const v = z
        .object({ taskId: uuid, proof: z.string().trim().min(15).max(5000) })
        .parse(body)
      await db.transaction(async (tx) => {
        await tx.select().from(users).where(eq(users.id, user.id)).for('update')
        const [sub] = await tx
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.userId, user.id))
          .orderBy(desc(subscriptions.createdAt))
          .limit(1)
        const [task] = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.id, v.taskId))
          .for('update')
        if (!sub || sub.expiresAt <= new Date())
          fail('An active subscription is required.', 402)
        if (
          !task?.active ||
          ranks[task.category as keyof typeof ranks] >
            ranks[sub.plan as keyof typeof ranks]
        )
          fail('This task is not available on your plan.', 403)
        const [existing] = await tx
          .select()
          .from(submissions)
          .where(
            and(
              eq(submissions.userId, user.id),
              eq(submissions.taskId, task.id),
            ),
          )
        if (existing) fail('You have already submitted this task.', 409)
        await tx.insert(submissions).values({
          userId: user.id,
          taskId: task.id,
          proof: v.proof,
          reward: task.reward,
        })
      })
      return Response.json(
        {
          message:
            'Proof submitted for review. Your wallet is credited only after approval.',
        },
        { headers },
      )
    }
    if (path === 'withdraw') {
      post()
      await rate(`withdraw:${user.id}`, 15, 3600)
      const v = z
        .object({
          amount: z.number().int().min(100000).max(100000000),
          bankName: z.string().trim().min(2).max(100),
          accountNumber: z
            .string()
            .regex(/^\d{10}$/, 'Enter a 10-digit account number.'),
          accountName: z.string().trim().min(3).max(100),
        })
        .parse(body)
      await db.transaction(async (tx) => {
        const [wallet] = await tx
          .select()
          .from(wallets)
          .where(eq(wallets.userId, user.id))
          .for('update')
        const pending = await tx
          .select()
          .from(withdrawals)
          .where(
            and(
              eq(withdrawals.userId, user.id),
              sql`${withdrawals.status} in ('Pending','Approved')`,
            ),
          )
        const reserved = pending.reduce((a, w) => a + w.amount, 0)
        if (wallet.balance - reserved < v.amount)
          fail(
            'Insufficient unreserved balance. Pending and approved requests reserve funds.',
            409,
          )
        await tx.insert(withdrawals).values({ ...v, userId: user.id })
      })
      return Response.json(
        {
          message:
            'Withdrawal requested. Your balance is debited only when the administrator marks it paid.',
        },
        { headers },
      )
    }
    if (path === 'payment/start') {
      post()
      if (!env('PAYSTACK_SECRET_KEY'))
        fail(
          'Subscription payments are not available yet. No payment was taken and no subscription was activated.',
          503,
        )
      await rate(`payment:${user.id}`, 20, 3600)
      const plan = planSchema.parse(body.plan)
      const reference = `TN-${randomUUID()}`
      await db
        .insert(payments)
        .values({ reference, userId: user.id, plan, amount: prices[plan] })
      const origin = new URL(req.url).origin
      const result = await paystack('/transaction/initialize', {
        email: user.email,
        amount: prices[plan],
        currency: 'NGN',
        reference,
        callback_url: `${origin}/checkout?reference=${reference}`,
        metadata: { userId: user.id, plan },
      })
      return Response.json({ url: result.authorization_url }, { headers })
    }
    if (path === 'payment/verify') {
      post()
      const reference = z
        .string()
        .regex(/^TN-[a-f0-9-]{36}$/)
        .parse(body.reference)
      return Response.json(
        await verifyPayment(reference, isAdmin ? undefined : user.id),
        { headers },
      )
    }
    if (path === 'support') {
      if (req.method === 'GET')
        return Response.json(
          await db
            .select()
            .from(tickets)
            .where(eq(tickets.userId, user.id))
            .orderBy(desc(tickets.createdAt)),
          { headers },
        )
      await rate(`support:${user.id}`, 10, 3600)
      const v = z
        .object({
          subject: z.string().trim().min(5).max(120),
          message: z.string().trim().min(15).max(5000),
        })
        .parse(body)
      await db.insert(tickets).values({ ...v, userId: user.id })
      return Response.json(
        {
          message:
            'Your support request has been received. Replies appear on this page.',
        },
        { headers },
      )
    }
    if (path.startsWith('admin')) {
      if (!isAdmin) fail('Administrator access is required.', 403)
      if (path === 'admin/data') {
        const [
          members,
          allSubscriptions,
          allPayments,
          allTasks,
          allSubmissions,
          allWithdrawals,
          allTransactions,
          allTickets,
        ] = await Promise.all([
          db
            .select({
              id: users.id,
              name: users.name,
              email: users.email,
              suspended: users.suspended,
              balance: wallets.balance,
            })
            .from(users)
            .leftJoin(wallets, eq(wallets.userId, users.id)),
          db.select().from(subscriptions),
          db.select().from(payments).orderBy(desc(payments.createdAt)),
          db.select().from(tasks).orderBy(desc(tasks.createdAt)),
          db
            .select({
              submission: submissions,
              task: tasks.title,
              email: users.email,
            })
            .from(submissions)
            .innerJoin(tasks, eq(tasks.id, submissions.taskId))
            .innerJoin(users, eq(users.id, submissions.userId))
            .orderBy(desc(submissions.createdAt)),
          db.select().from(withdrawals).orderBy(desc(withdrawals.createdAt)),
          db.select().from(transactions).orderBy(desc(transactions.createdAt)),
          db.select().from(tickets).orderBy(desc(tickets.createdAt)),
        ])
        return Response.json(
          {
            users: members,
            activeSubscribers: new Set(
              allSubscriptions
                .filter((s) => s.expiresAt > new Date())
                .map((s) => s.userId),
            ).size,
            revenue: allPayments
              .filter((p) => p.status === 'Success')
              .reduce((a, p) => a + p.amount, 0),
            payments: allPayments,
            tasks: allTasks,
            submissions: allSubmissions,
            withdrawals: allWithdrawals,
            transactions: allTransactions,
            tickets: allTickets,
          },
          { headers },
        )
      }
      post()
      if (path === 'admin/task') {
        const v = z
          .object({
            id: uuid.optional(),
            title: z.string().trim().min(3).max(150),
            description: z.string().trim().min(10).max(2000),
            instructions: z.string().trim().min(10).max(5000),
            category: planSchema,
            reward: z.number().int().min(100).max(10000000),
            difficulty: z.enum(['Easy', 'Moderate', 'Advanced']),
            active: z.boolean(),
          })
          .parse(body)
        await db.transaction(async (tx) => {
          if (v.id) await tx.update(tasks).set(v).where(eq(tasks.id, v.id))
          else await tx.insert(tasks).values(v)
          await tx.insert(audit).values({
            adminId: user.id,
            action: 'Save task',
            targetId: v.id || v.title,
          })
        })
      } else if (path === 'admin/task-delete') {
        const id = uuid.parse(body.id)
        await db.transaction(async (tx) => {
          const existing = await tx
            .select()
            .from(submissions)
            .where(eq(submissions.taskId, id))
            .limit(1)
          if (existing.length)
            fail(
              'This task has submissions. Deactivate it to preserve financial records.',
            )
          await tx.delete(tasks).where(eq(tasks.id, id))
          await tx
            .insert(audit)
            .values({ adminId: user.id, action: 'Delete task', targetId: id })
        })
      } else if (path === 'admin/submission') {
        const v = z
          .object({
            id: uuid,
            status: z.enum(['Approved', 'Rejected']),
            note: z.string().trim().max(1000).default(''),
          })
          .parse(body)
        await db.transaction(async (tx) => {
          const [s] = await tx
            .select()
            .from(submissions)
            .where(eq(submissions.id, v.id))
            .for('update')
          if (!s || s.status !== 'Pending')
            fail(
              'This submission has already been reviewed or does not exist.',
              409,
            )
          await tx
            .update(submissions)
            .set({ status: v.status, reviewNote: v.note, reviewedBy: user.id })
            .where(eq(submissions.id, v.id))
          if (v.status === 'Approved') {
            const [member] = await tx
              .select()
              .from(users)
              .where(eq(users.id, s.userId))
            if (member.suspended)
              fail(
                'This account is suspended. Review the account before approval.',
              )
            await tx
              .select()
              .from(wallets)
              .where(eq(wallets.userId, s.userId))
              .for('update')
            await tx.insert(transactions).values({
              userId: s.userId,
              amount: s.reward,
              kind: 'Task reward',
              reference: `submission:${s.id}`,
              description: 'Approved task reward',
            })
            await tx
              .update(wallets)
              .set({ balance: sql`${wallets.balance}+${s.reward}` })
              .where(eq(wallets.userId, s.userId))
          }
          await tx.insert(audit).values({
            adminId: user.id,
            action: `Submission ${v.status}`,
            targetId: s.id,
          })
        })
      } else if (path === 'admin/withdrawal') {
        const v = z
          .object({
            id: uuid,
            status: z.enum(['Approved', 'Rejected', 'Paid']),
            note: z.string().trim().max(1000).default(''),
            transferReference: z.string().trim().max(120).optional(),
          })
          .parse(body)
        if (
          v.status === 'Paid' &&
          (!v.transferReference || v.transferReference.length < 5)
        )
          fail(
            'Enter the actual bank transfer reference before marking this withdrawal paid.',
          )
        await db.transaction(async (tx) => {
          const [w] = await tx
            .select()
            .from(withdrawals)
            .where(eq(withdrawals.id, v.id))
            .for('update')
          if (!w) fail('Withdrawal not found.', 404)
          if (
            (v.status === 'Paid' && w.status !== 'Approved') ||
            (v.status === 'Approved' && w.status !== 'Pending') ||
            (v.status === 'Rejected' &&
              !['Pending', 'Approved'].includes(w.status))
          )
            fail('This withdrawal cannot move to that status.', 409)
          const [wallet] = await tx
            .select()
            .from(wallets)
            .where(eq(wallets.userId, w.userId))
            .for('update')
          if (v.status === 'Paid') {
            const [member] = await tx
              .select()
              .from(users)
              .where(eq(users.id, w.userId))
            if (member.suspended)
              fail('This account is suspended. Review it before payment.')
            if (wallet.balance < w.amount)
              fail('Wallet balance is insufficient.', 409)
            await tx.insert(transactions).values({
              userId: w.userId,
              amount: -w.amount,
              kind: 'Withdrawal',
              reference: `withdrawal:${w.id}`,
              description: `Bank withdrawal • ${w.bankName}`,
            })
            await tx
              .update(wallets)
              .set({ balance: sql`${wallets.balance}-${w.amount}` })
              .where(eq(wallets.userId, w.userId))
          }
          await tx
            .update(withdrawals)
            .set({
              status: v.status,
              reviewNote: v.note,
              reviewedBy: user.id,
              ...(v.status === 'Paid'
                ? { transferReference: v.transferReference }
                : {}),
            })
            .where(eq(withdrawals.id, w.id))
          await tx.insert(audit).values({
            adminId: user.id,
            action: `Withdrawal ${v.status}`,
            targetId: w.id,
          })
        })
      } else if (path === 'admin/suspend') {
        const v = z
          .object({ id: z.string().min(1).max(100), suspended: z.boolean() })
          .parse(body)
        if (v.id === user.id)
          fail('You cannot suspend your own administrator account.')
        await db.transaction(async (tx) => {
          await tx
            .update(users)
            .set({ suspended: v.suspended })
            .where(eq(users.id, v.id))
          await tx.insert(audit).values({
            adminId: user.id,
            action: v.suspended ? 'Suspend account' : 'Restore account',
            targetId: v.id,
          })
        })
      } else if (path === 'admin/reply') {
        const v = z
          .object({ id: uuid, reply: z.string().trim().min(5).max(5000) })
          .parse(body)
        await db
          .update(tickets)
          .set({ reply: v.reply })
          .where(eq(tickets.id, v.id))
      } else fail('Endpoint not found.', 404)
      return Response.json({ message: 'Changes saved.' }, { headers })
    }
    fail('Endpoint not found.', 404)
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json(
        {
          error: error.issues[0]?.message || 'Check the submitted information.',
        },
        { status: 400, headers },
      )
    if (error instanceof Problem)
      return Response.json(
        { error: error.message },
        { status: error.status, headers },
      )
    // Do not log gateway responses, bank information, credentials, or database parameters.
    return Response.json(
      {
        error:
          'Unable to complete this request. Please try again or contact support.',
      },
      { status: 500, headers },
    )
  }
}
export const config: Config = { path: '/api/*' }
