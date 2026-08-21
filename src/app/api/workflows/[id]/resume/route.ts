import { fail, guard, ok } from "@/app/api/_lib/handler";
import { resumeWorkflow } from "@/engine/workflow/engine";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await guard("task:run", 30);
    const { id } = await params;
    const run = await resumeWorkflow(id, auth.userId);
    return ok({ ok: run.status !== "FAILED", ...run, context: undefined, outputs: run.context.outputs });
  } catch (e) {
    return fail(e);
  }
}
