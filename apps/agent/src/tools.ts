import { FunctionDeclaration } from '@google/genai';

// Function declarations sent to Gemini. None of the tools takes a student number:
// the agent always uses the logged-in student's identity from the JWT.

export const TOOL_SEARCH_POLICIES = 'search_tuition_policies';
export const TOOL_GET_MY_TUITION = 'get_my_tuition';
export const TOOL_PAY_MY_TUITION = 'pay_my_tuition';

const TERM_SCHEMA = {
  type: 'string',
  pattern: '^[0-9]{4}-(FALL|SPRING|SUMMER)$',
  description: 'Academic term such as 2026-FALL, 2027-SPRING or 2027-SUMMER',
};

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: TOOL_SEARCH_POLICIES,
    description:
      'Searches the official university tuition policy document: payment deadlines, installments, late fees, ' +
      'scholarships, refunds and withdrawals, banking and payment rules. Returns passages with section numbers ' +
      'to cite. Use for any question about rules. Contains no student-specific data.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Short English keyword query, e.g. "spring payment deadline" (translate if the user wrote in another language)',
        },
        limit: { type: 'integer', minimum: 1, maximum: 5, description: 'Maximum passages to return (default 3)' },
      },
      required: ['query'],
    },
  },
  {
    name: TOOL_GET_MY_TUITION,
    description:
      "Returns the logged-in student's live tuition total, amount paid and outstanding balance in USD, " +
      'for one term or for all terms with a per-term breakdown. Use whenever the answer depends on the ' +
      "student's own balance. It can only read the logged-in student's own record.",
    parametersJsonSchema: {
      type: 'object',
      properties: { term: { ...TERM_SCHEMA, description: `${TERM_SCHEMA.description}. Omit for all terms.` } },
    },
  },
  {
    name: TOOL_PAY_MY_TUITION,
    description:
      "Requests a (simulated) tuition payment for the logged-in student. The payment is NOT made by this call: " +
      'the assistant shows the student, term, amount and current balance and the user must explicitly confirm ' +
      'in their next message. Call it only when the user clearly asks to pay a specific amount for a specific term.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        term: TERM_SCHEMA,
        amount: { type: 'number', exclusiveMinimum: 0, description: 'Amount in USD, at most 2 decimal places' },
      },
      required: ['term', 'amount'],
    },
  },
];
