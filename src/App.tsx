import { useCounter } from "./hooks/useCounter";

const App = () => {
  const { count, increment, decrement } = useCounter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100">
      <div className="rounded-lg bg-white p-8 text-center shadow-lg">
        <h1 className="mb-4 text-4xl font-bold text-gray-800">Counter Demo</h1>
        <output
          aria-live="polite"
          aria-label="Current count"
          className="mb-6 text-6xl font-bold text-blue-600"
        >
          {count}
        </output>
        <div className="flex space-x-4">
          <button
            type="button"
            aria-label="Decrement count"
            onClick={decrement}
            className="grow border-2 p-2 text-2xl"
          >
            -
          </button>
          <button
            type="button"
            aria-label="Increment count"
            onClick={increment}
            className="grow border-2 p-2 text-2xl"
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;
