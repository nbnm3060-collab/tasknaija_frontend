import type { Config } from '@netlify/edge-functions'

// Authorize the page with the same server-side check used by every admin API action.
export default async (req: Request) => {
  try {
    const result = await fetch(new URL('/api/me', req.url), {
      headers: { cookie: req.headers.get('cookie') || '' },
      redirect: 'manual',
    })
    if (result.status === 401) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/login', 'Cache-Control': 'no-store' },
      })
    }
    if (!result.ok) {
      return new Response(
        'Account access is unavailable. Please return to TaskNaija and sign in again.',
        {
          status: result.status === 403 ? 403 : 503,
          headers: {
            'Cache-Control': 'no-store',
            'Content-Type': 'text/plain; charset=utf-8',
          },
        },
      )
    }
    const account = await result.json()
    if (!account.user?.isAdmin) {
      return new Response('Administrator access is required.', {
        status: 403,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
        },
      })
    }
    return
  } catch {
    return new Response(
      'Account verification is temporarily unavailable. Please try again.',
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      },
    )
  }
}
export const config: Config = { path: ['/admin', '/admin/*'] }
