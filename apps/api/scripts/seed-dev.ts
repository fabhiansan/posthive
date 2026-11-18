/**
 * Dev only: one workspace with a person for each role, so a fresh or reset local database can be signed in to.
 *
 * Usage (the password is yours; it is never kept in the repo):
 *   pnpm db:seed-dev <password>
 *
 * Makes admin@gmail.com (owner), marketing@gmail.com (Marketing) and designer@gmail.com (designer) in the
 * workspace "Posthive Dev", with approval on. Refuses a database that is not on this machine, and stops
 * without writing anything if one of the emails already exists.
 */

import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { passwordProblem } from "../src/lib/auth/passwordPolicy.js";

const prisma = new PrismaClient();

const PEOPLE = [
  { email: "admin@gmail.com", name: "Admin Dev", role: "owner" },
  { email: "marketing@gmail.com", name: "Marketing Dev", role: "member" },
  { email: "designer@gmail.com", name: "Designer Dev", role: "designer" },
];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const password = process.argv[2];
  if (!password) fail("Usage: pnpm db:seed-dev <password>");
  const problem = passwordProblem(password);
  if (problem) fail(problem);

  const host = new URL(process.env.DATABASE_URL ?? "postgresql://missing").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") fail(`DATABASE_URL points at ${host}. This script only seeds a database on this machine.`);

  const taken = await prisma.user.findMany({ where: { email: { in: PEOPLE.map((p) => p.email) } }, select: { email: true } });
  if (taken.length > 0) fail(`Already exists: ${taken.map((u) => u.email).join(", ")}. Nothing was written.`);

  const passwordHash = await bcrypt.hash(password, 12); // same cost as localAuth.register

  await prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: { name: "Posthive Dev", plan: "team", planStatus: "active", approvalRequired: true, allowTrial: false },
    });
    for (const p of PEOPLE) {
      const user = await tx.user.create({
        data: { email: p.email, name: p.name, passwordHash, emailVerified: true, activeWorkspaceId: workspace.id },
      });
      await tx.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: p.role } });
    }
  });

  console.log(`Seeded workspace "Posthive Dev" with:\n${PEOPLE.map((p) => `  ${p.email} (${p.role})`).join("\n")}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
