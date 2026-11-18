// Demo data for local runs, tests by hand and the cloud demo. All names are fictitious.
// Amounts are USD strings with 2 decimals, so no float arithmetic is involved.

export const DEMO_PASSWORDS = {
  ADMIN: 'Admin#2026',
  BANK: 'Bank#2026',
  STUDENT: 'Student#2026',
} as const;

export const SERVICE_USERS = [
  { username: 'admin', role: 'ADMIN' as const },
  { username: 'bank', role: 'BANK' as const },
];

export interface SeedPayment {
  /** Idempotency key; fixed so re-running the seed does not create duplicates. */
  transactionId: string;
  amount: string;
  /** Who submitted the payment: the student themself or the bank system account. */
  paidBy: 'STUDENT' | 'BANK';
  paidAt: string;
}

export interface SeedTuition {
  term: string;
  amount: string;
  payments: SeedPayment[];
}

export interface SeedStudent {
  studentNo: string;
  fullName: string;
  tuitions: SeedTuition[];
}

const FULL_NAMES = [
  'Elif Demir', // 20230001 - main demo student (agent scenarios)
  'Can Öztürk', // 20230002 - second student (cross-student access demo)
  'Deniz Kaya', // 20230003 - unpaid, matches docs/API.md example
  'Zeynep Arslan',
  'Mert Çelik',
  'Selin Aydın',
  'Emre Şahin',
  'Ece Yıldız',
  'Burak Koç',
  'İrem Kurt',
  'Kaan Özdemir',
  'Melis Polat',
  'Onur Erdoğan',
  'Defne Aksoy',
  'Arda Güneş',
  'Nehir Tekin',
  'Yusuf Bulut',
  'Cansu Kılıç',
  'Barış Doğan',
  'Ceren Yavuz',
  'Ozan Aslan',
  'Gizem Çetin',
  'Tolga Uçar',
  'Duru Karaca',
  'Efe Turan', // 20230025 - student with no tuition records
];

function studentNo(index: number): string {
  return `2023${String(index + 1).padStart(4, '0')}`;
}

function txId(studentNumber: string, term: string, n: number): string {
  return `seed-${studentNumber}-${term}-${n}`;
}

// Hand-written records for the students used in the demos and examples.
const SPECIAL: Record<string, SeedTuition[]> = {
  // Partially paid Fall term + unpaid Spring term (docs/API.md overall query example).
  '20230001': [
    {
      term: '2026-FALL',
      amount: '3000.00',
      payments: [
        {
          transactionId: txId('20230001', '2026-FALL', 1),
          amount: '1500.00',
          paidBy: 'STUDENT',
          paidAt: '2026-09-20T10:00:00.000Z',
        },
      ],
    },
    { term: '2027-SPRING', amount: '3000.00', payments: [] },
  ],
  // Fully paid Fall term (paid by the bank system), unpaid Spring term.
  '20230002': [
    {
      term: '2026-FALL',
      amount: '2500.00',
      payments: [
        {
          transactionId: txId('20230002', '2026-FALL', 1),
          amount: '2500.00',
          paidBy: 'BANK',
          paidAt: '2026-09-15T09:30:00.000Z',
        },
      ],
    },
    { term: '2027-SPRING', amount: '2500.00', payments: [] },
  ],
  // Nothing paid (docs/API.md unpaid list example).
  '20230003': [{ term: '2026-FALL', amount: '3000.00', payments: [] }],
  // Fully paid in two payments.
  '20230004': [
    {
      term: '2026-FALL',
      amount: '2800.00',
      payments: [
        {
          transactionId: txId('20230004', '2026-FALL', 1),
          amount: '1400.00',
          paidBy: 'STUDENT',
          paidAt: '2026-09-10T08:00:00.000Z',
        },
        {
          transactionId: txId('20230004', '2026-FALL', 2),
          amount: '1400.00',
          paidBy: 'STUDENT',
          paidAt: '2026-09-28T08:00:00.000Z',
        },
      ],
    },
  ],
  // Remaining balance below $300: not eligible for installments (policy §3.1).
  '20230005': [
    {
      term: '2026-FALL',
      amount: '3000.00',
      payments: [
        {
          transactionId: txId('20230005', '2026-FALL', 1),
          amount: '2750.00',
          paidBy: 'BANK',
          paidAt: '2026-09-25T12:00:00.000Z',
        },
      ],
    },
  ],
  // No tuition records at all.
  '20230025': [],
};

const GENERIC_AMOUNTS = ['2500.00', '2750.00', '3000.00', '3250.00', '3500.00'];

// Every other student gets an unpaid or partially paid Fall 2026 record, so the Fall term
// has more than 20 unpaid students and the unpaid list has a second page at the default page size.
function genericTuitions(index: number, number: string): SeedTuition[] {
  const amount = GENERIC_AMOUNTS[index % GENERIC_AMOUNTS.length];
  const payments: SeedPayment[] =
    index % 3 === 0
      ? [
          {
            transactionId: txId(number, '2026-FALL', 1),
            amount: '1000.00',
            paidBy: index % 2 === 0 ? 'STUDENT' : 'BANK',
            paidAt: '2026-09-18T14:00:00.000Z',
          },
        ]
      : [];
  return [{ term: '2026-FALL', amount, payments }];
}

export const SEED_STUDENTS: SeedStudent[] = FULL_NAMES.map((fullName, index) => {
  const number = studentNo(index);
  return {
    studentNo: number,
    fullName,
    tuitions: SPECIAL[number] ?? genericTuitions(index, number),
  };
});
