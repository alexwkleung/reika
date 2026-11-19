import type { ApprovalRequest, QuestionRequest } from '../types.js';
import type { ConfirmSpec } from './dialogspecs.js';
import { scrubDisplay, scrubPreview } from './scrub.js';

// The dialogs' text as drawn (#1015). Each dialog lays itself out from the copy it draws, so the
// rows it measures are the rows on screen; the request the answer goes back against is untouched.

export function scrubApproval(request: ApprovalRequest): ApprovalRequest {
  return {
    ...request,
    subject: scrubDisplay(request.subject),
    preview: scrubPreview(request.preview),
    ...(request.warnings ? { warnings: request.warnings.map(w => scrubDisplay(w)) } : {}),
  };
}

export function scrubQuestion(request: QuestionRequest): QuestionRequest {
  return {
    ...request,
    question: scrubDisplay(request.question),
    options: request.options.map(o => ({
      ...o,
      label: scrubDisplay(o.label),
      ...(o.description !== undefined ? { description: scrubDisplay(o.description) } : {}),
    })),
  };
}

export function scrubConfirm(spec: ConfirmSpec): ConfirmSpec {
  return {
    ...spec,
    title: scrubDisplay(spec.title),
    subtitle: scrubDisplay(spec.subtitle),
    details: spec.details.map(d => scrubDisplay(d)),
    options: spec.options.map(o => scrubDisplay(o)),
  };
}
