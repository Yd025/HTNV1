import dynamic from 'next/dynamic';
import Head from 'next/head';
const Game = dynamic(() => import('../components/Game'), { ssr: false,
  loading: () => <main className="loading-screen"><span className="loading-mark"/><p>Opening the strait…</p></main> });
export default function Home() {
  return <><Head><title>Can't Catch Me — Fort Ross</title><meta name="description" content="An Arctic boat chase. Slip past the towers, outmaneuver the drone, and see how long you can stay free."/><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/><meta name="theme-color" content="#183d4c"/></Head><Game/></>;
}
