import { redirect } from "next/navigation";
import { currentAuth } from "@/core/security/auth";
import { prisma } from "@/core/db/client";
import { LoginForm } from "@/app/login/login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const auth = await currentAuth();
  if (auth) redirect("/dashboard");

  // Show the demo credentials only when the seeded demo account is the sole
  // user - never on a real deployment with real accounts.
  const userCount = await prisma.user.count().catch(() => 0);
  const demoUser = await prisma.user.findUnique({ where: { email: "admin@faresmatch.local" } }).catch(() => null);
  const showDemoHint = userCount === 1 && Boolean(demoUser);

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-[var(--color-brand)] text-lg font-bold text-white">
            F
          </span>
          <h1 className="text-[19px] font-semibold tracking-[-0.01em]">FaresMatch AI OS</h1>
          <p className="mt-1 text-[12.5px] text-[var(--color-ink-3)]">
            Programmatic SEO, AEO, GEO &amp; AI visibility operating system
          </p>
        </div>

        <div className="fm-card p-5">
          <LoginForm />
        </div>

        {showDemoHint ? (
          <div
            className="mt-4 rounded-lg border p-3 text-[12px]"
            style={{ background: "var(--color-mock-soft)", borderColor: "var(--color-mock)", color: "var(--color-mock)" }}
          >
            <div className="font-semibold">Seeded demo account</div>
            <div className="mt-1 font-mono text-[11.5px]">
              admin@faresmatch.local
              <br />
              faresmatch-demo-2026
            </div>
            <div className="mt-1.5 opacity-90">Change this before exposing the app to anything but localhost.</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
