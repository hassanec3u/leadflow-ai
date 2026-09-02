import Link from 'next/link'

import { signInAction } from '@/app/(auth)/actions'
import { AuthForm } from '@/components/auth/auth-form'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata = { title: 'Sign in — LeadFlow AI' }

export default async function LoginPage(props: PageProps<'/login'>) {
  const searchParams = await props.searchParams
  const rawCallback = searchParams.callbackUrl
  const callbackUrl = typeof rawCallback === 'string' ? rawCallback : ''

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Continue to your workspace.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <AuthForm
          action={signInAction}
          submitLabel="Sign in"
          hiddenFields={callbackUrl ? { callbackUrl } : undefined}
          fields={[
            {
              name: 'email',
              label: 'Email',
              type: 'email',
              autoComplete: 'email',
              placeholder: 'you@company.com',
            },
            {
              name: 'password',
              label: 'Password',
              type: 'password',
              autoComplete: 'current-password',
            },
          ]}
        />
        <p className="text-muted-foreground text-center text-sm">
          Don&apos;t have an account?{' '}
          <Link href="/signup" className="text-primary font-medium hover:underline">
            Create one
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}
