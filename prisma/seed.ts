import 'dotenv/config'

import { randomBytes } from 'node:crypto'

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

import { createUserSchema } from '../lib/validation/auth'

/**
 * Account provisioning.
 *
 * There is no public sign-up: the application serves one company, so accounts
 * are created deliberately by whoever runs the deployment rather than by
 * whoever reaches the login page first.
 *
 *   npx tsx prisma/seed.ts --email you@company.com --name "Your Name" --role ADMIN
 *
 * Omit --password and one is generated and printed once. It is printed to
 * stdout on purpose — this is an operator running a command in their own
 * terminal, not application logging — and never stored anywhere but as a
 * bcrypt hash.
 *
 * Re-running with an existing email updates that user's name and role and
 * leaves their password alone, so this is safe to run twice.
 */

// Matches lib/services/* — the cost the application itself verifies against.
const BCRYPT_COST = 12

type Args = {
  email?: string
  name?: string
  role?: string
  password?: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (!flag?.startsWith('--') || value === undefined) continue
    const key = flag.slice(2) as keyof Args
    args[key] = value
  }
  return args
}

function usage(message: string): never {
  console.error(`${message}

Usage:
  npx tsx prisma/seed.ts --email <email> --name <name> --role <ADMIN|MANAGER|SALES_REP> [--password <password>]`)
  process.exit(1)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!args.email || !args.name || !args.role) {
    usage('Missing required argument.')
  }

  // A generated password is 32 bytes of CSPRNG output rendered base64url —
  // comfortably past the 12-character floor, and not something a person picked.
  const generated = args.password === undefined
  const password = args.password ?? randomBytes(24).toString('base64url')

  const parsed = createUserSchema.safeParse({
    email: args.email,
    name: args.name,
    role: args.role,
    password,
  })

  if (!parsed.success) {
    usage(
      `Invalid input:\n${parsed.error.issues
        .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n')}`,
    )
  }

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) usage('DATABASE_URL is not set.')

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

  try {
    const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_COST)

    const user = await prisma.user.upsert({
      where: { email: parsed.data.email },
      // An existing account keeps its password: re-running this to fix a name
      // or a role must not silently lock someone out.
      update: { name: parsed.data.name, role: parsed.data.role },
      create: {
        email: parsed.data.email,
        name: parsed.data.name,
        role: parsed.data.role,
        passwordHash,
      },
      select: { id: true, email: true, role: true, createdAt: true, updatedAt: true },
    })

    const created = user.createdAt.getTime() === user.updatedAt.getTime()
    console.log(`${created ? 'Created' : 'Updated'} ${user.email} (${user.role})`)

    if (created && generated) {
      console.log(`Password: ${password}`)
      console.log('This is shown once. Store it now.')
    } else if (!created) {
      console.log('Password left unchanged.')
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error('Seeding failed:', error)
  process.exit(1)
})
