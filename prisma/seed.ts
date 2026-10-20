import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const ROLES = [
  'Admin',
  'Department Head',
  'Event Coordinator',
  'Instructor',
  'Student Officer',
  'Student',
] as const;

async function main() {
  const prisma = new PrismaClient();
  try {
    for (const name of ROLES) {
      await prisma.role.upsert({
        where: { name },
        update: {},
        create: { name },
      });
    }

    const adminEmail = process.env.SEED_ADMIN_EMAIL;
    const adminPassword = process.env.SEED_ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) {
      console.log(
        `Seeded ${ROLES.length} roles. Admin user skipped: set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to provision it.`,
      );
      return;
    }

    const passwordHash = await bcrypt.hash(adminPassword, 10);
    const admin = await prisma.user.upsert({
      where: { email: adminEmail },
      update: {},
      create: {
        email: adminEmail,
        passwordHash,
        firstName: 'Demo',
        lastName: 'Admin',
        userRoles: {
          create: [{ role: { connect: { name: 'Admin' } } }],
        },
      },
    });

    console.log(`Seeded ${ROLES.length} roles and admin user ${admin.email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
