import { BrowserPane } from "./BrowserPane"

export function TeamBrowser({ chatId, names, initialPage }: { chatId: string; names: Record<string,string>; initialPage?: string }) {
  return <BrowserPane session={`team:${chatId}`} names={names} initialPage={initialPage} />
}
