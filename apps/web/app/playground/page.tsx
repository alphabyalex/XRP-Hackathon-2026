import { CodeSample } from "@/components/CodeSample";
import { PlaygroundTry } from "@/components/PlaygroundTry";

export default function PlaygroundPage() {
  return (
    <main className="s tinted">
      <div className="wrap">
        <div className="shead">
          <h2>Point your OpenAI client here.</h2>
          <p>Moonshift&apos;s router speaks the OpenAI API. Every token you pay for goes to the shareholders of whichever GPU served it.</p>
        </div>
        <div className="dev">
          <CodeSample />
          <PlaygroundTry />
        </div>
      </div>
    </main>
  );
}
