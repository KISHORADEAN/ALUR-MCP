import readline from 'node:readline/promises';

export interface ApprovalRequest {
  stage: string;
  action: string;
  details: string[];
}

export interface ApprovalDecision {
  approved: boolean;
  source: 'flag' | 'interactive' | 'non-interactive';
  reason: string;
}

export interface Approver {
  approve(request: ApprovalRequest): Promise<ApprovalDecision>;
}

interface ApprovalGateOptions {
  autoApprove: boolean;
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream & { isTTY?: boolean };
}

/**
 * Human approval gate for mutating browser actions. There is deliberately no
 * "default yes": absence of an interactive terminal without --yes is a denial.
 */
export class ApprovalGate implements Approver {
  private readonly autoApprove: boolean;
  private readonly input: NodeJS.ReadableStream & { isTTY?: boolean };
  private readonly output: NodeJS.WritableStream & { isTTY?: boolean };

  constructor(options: ApprovalGateOptions) {
    this.autoApprove = options.autoApprove;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
  }

  async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.autoApprove) {
      return {
        approved: true,
        source: 'flag',
        reason: 'Pre-approved with the explicit --yes command-line flag.',
      };
    }

    if (!this.input.isTTY || !this.output.isTTY) {
      return {
        approved: false,
        source: 'non-interactive',
        reason: 'No interactive terminal is available. Re-run from a terminal or explicitly pass --yes.',
      };
    }

    const rl = readline.createInterface({ input: this.input, output: this.output, terminal: true });
    try {
      this.output.write('\n');
      this.output.write(`APPROVAL REQUIRED: ${request.action}\n`);
      for (const detail of request.details) this.output.write(`  - ${detail}\n`);
      this.output.write('Type "yes" to approve this single step, or press Enter to cancel: ');
      const answer = (await rl.question('')).trim().toLowerCase();
      if (answer === 'yes' || answer === 'y') {
        return {
          approved: true,
          source: 'interactive',
          reason: 'Approved interactively for this single step.',
        };
      }
      return {
        approved: false,
        source: 'interactive',
        reason: 'The operator did not type "yes".',
      };
    } finally {
      rl.close();
    }
  }
}
