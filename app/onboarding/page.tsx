import { redirect } from "next/navigation";
import { getDefaultStorage } from "@/lib/engine/storage";
import { getCurrentAccount } from "@/lib/session";
import OnboardingForm from "./onboarding-form";

export const instant = false;

export default async function OnboardingPage() {
  const storage = getDefaultStorage();
  const account = await getCurrentAccount(storage);
  if (!account) redirect("/login");
  if (storage.getProfile(account.userId)) redirect("/");

  return <OnboardingForm email={account.email} />;
}
