import Link from 'next/link'

import { signUpAction } from '@/app/(auth)/actions'
import { AuthForm } from '@/components/auth/auth-form'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata = { title: 'Create your workspace — LeadFlow AI' }

export default function SignUpPage() {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Create your workspace</CardTitle>
        <CardDescription>You&apos;ll be the administrator of this organization.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <AuthForm
          action={signUpAction}
          submitLabel="Create workspace"
          fields={[
            {
              name: 'organizationName',
              label: 'Organization',
              autoComplete: 'organization',
              placeholder: 'Acme Inc.',
            },
            { name: 'name', label: 'Your name', autoComplete: 'name', placeholder: 'Jane Doe' },
            {
              name: 'email',
              label: 'Work email',
              type: 'email',
              autoComplete: 'email',
              placeholder: 'you@company.com',
            },
            {
              name: 'password',
              label: 'Password',
              type: 'password',
              autoComplete: 'new-password',
              placeholder: 'At least 12 characters',
            },
          ]}
        />
        <p className="text-muted-foreground text-center text-sm">
          Already have an account?{' '}
          <Link href="/login" className="text-primary font-medium hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}
