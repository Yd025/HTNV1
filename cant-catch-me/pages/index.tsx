import dynamic from 'next/dynamic';
import Head from 'next/head';
import LoadingScreen from '../components/LoadingScreen';
const Game = dynamic(() => import('../components/Game'), { ssr: false,
  loading: ({ error }) => <LoadingScreen error={error ? 'The game couldn’t open. Check your connection and try again.' : undefined} onRetry={() => location.reload()}/> });
export default function Home() {
  return <><Head><title>Can't Catch Me — Fort Ross</title><meta name="description" content="An endless Arctic boat escape. Catch a speed boost, leave the patrol behind, and explore the coast beyond Fort Ross."/><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/><meta name="theme-color" content="#183d4c"/></Head><Game/></>;
}
