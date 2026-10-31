let balance = 3;

export function getCredits(): number {
  return balance;
}

export function addCredits(amount: number): number {
  balance += amount;
  return balance;
}

export function spendCredit(): boolean {
  if (balance <= 0) return false;
  balance -= 1;
  return true;
}
