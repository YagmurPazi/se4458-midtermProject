/** Minimal PrismaService double for tests that must run without a database. */
export function createMockPrisma() {
  const prisma = {
    user: { findUnique: jest.fn() },
    student: { findUnique: jest.fn() },
    tuition: { findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    payment: { findUnique: jest.fn(), aggregate: jest.fn(), create: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  // Interactive transactions run the callback against the same mock.
  prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(prisma));
  return prisma;
}

export type MockPrisma = ReturnType<typeof createMockPrisma>;
