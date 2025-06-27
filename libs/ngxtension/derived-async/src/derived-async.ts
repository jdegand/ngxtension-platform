import {
	DestroyRef,
	Injector,
	computed,
	effect,
	inject,
	signal,
	untracked,
	type CreateComputedOptions,
	type Signal,
	type ValueEqualityFn,
	type WritableSignal,
} from '@angular/core';
import { assertInjector } from 'ngxtension/assert-injector';
import {
	Observable,
	Subject,
	concatAll,
	exhaustAll,
	isObservable,
	mergeAll,
	of,
	switchAll,
} from 'rxjs';

type derivedAsyncBehavior = 'switch' | 'merge' | 'concat' | 'exhaust';

interface DerivedAsyncOptions<T>
	extends Omit<CreateComputedOptions<T>, 'equal'> {
	injector?: Injector;
	behavior?: derivedAsyncBehavior;
	equal?: ValueEqualityFn<T | undefined>;
}

type OptionsWithInitialValue<T> = {
	initialValue: T;
	requireSync?: false;
} & DerivedAsyncOptions<T>;

type OptionsWithRequireSync<T> = {
	requireSync: true;
	initialValue?: T;
} & DerivedAsyncOptions<T>;

type OptionsWithOptionalInitialValue<T> = {
	initialValue?: T;
	requireSync?: false;
} & DerivedAsyncOptions<T>;

type DerivedAsyncOptionsUnion<T> =
	| OptionsWithInitialValue<T>
	| OptionsWithRequireSync<T>
	| OptionsWithOptionalInitialValue<T>;

type ObservableComputation<T> = (previousValue?: T) => Observable<T> | T;
type PromiseComputation<T> = (previousValue?: T) => Promise<T> | T;

export function derivedAsync<T>(
	computation: ObservableComputation<T> | PromiseComputation<T>,
	options: DerivedAsyncOptionsUnion<T> = {},
): Signal<T | undefined> {
	return assertInjector(derivedAsync, options?.injector, () => {
		const destroyRef = inject(DestroyRef);
		const sourceEvent$ = new Subject<Promise<T> | Observable<T>>();
		const source$ = createFlattenObservable(
			sourceEvent$,
			options?.behavior ?? 'switch',
		);

		let sourceValue: WritableSignal<State<T>>;

		if (options?.requireSync && options?.initialValue === undefined) {
			const initialCmp = computation(undefined);

			if (isPromise(initialCmp)) {
				throw new Error(REQUIRE_SYNC_PROMISE_MESSAGE);
			}

			sourceValue = signal<State<T>>({ kind: StateKind.NoValue });

			if (isObservable(initialCmp)) {
				sourceEvent$.next(initialCmp);
			} else {
				if (initialCmp === undefined) {
					throw new Error(
						'Initial computation returned undefined, which is not assignable to T',
					);
				}
				sourceValue.set({ kind: StateKind.Value, value: initialCmp });
			}
		} else {
			sourceValue = signal<State<T>>({
				kind: StateKind.Value,
				value: options?.initialValue as T,
			});
		}

		const sourceResult = source$.subscribe({
			next: (value) => sourceValue.set({ kind: StateKind.Value, value }),
			error: (error) => sourceValue.set({ kind: StateKind.Error, error }),
		});

		destroyRef.onDestroy(() => sourceResult.unsubscribe());

		if (options?.requireSync && sourceValue().kind === StateKind.NoValue) {
			throw new Error(REQUIRE_SYNC_ERROR_MESSAGE);
		}

		let skipFirstComputation = options?.requireSync === true;

		effect(() => {
			const currentValue = untracked(() => {
				const currentSourceValue = sourceValue();
				return currentSourceValue.kind === StateKind.Value
					? currentSourceValue.value
					: undefined;
			});

			const newSource = computation(currentValue);

			if (skipFirstComputation) {
				skipFirstComputation = false;
				return;
			}

			untracked(() => {
				sourceEvent$.next(
					isObservable(newSource) || isPromise(newSource)
						? newSource
						: of(newSource),
				);
			});
		});

		return computed<T | undefined>(
			() => {
				const state = sourceValue();
				switch (state.kind) {
					case StateKind.Value:
						return state.value;
					case StateKind.Error:
						throw state.error;
					case StateKind.NoValue:
						return undefined;
					default:
						throw new Error('Unknown state');
				}
			},
			{ equal: options?.equal },
		);
	});
}

const REQUIRE_SYNC_PROMISE_MESSAGE = `Promises cannot be used with requireSync. Pass an initialValue or set requireSync to false.`;
const REQUIRE_SYNC_ERROR_MESSAGE = `The observable passed to derivedAsync() did not emit synchronously. Pass an initialValue or set requireSync to false.`;

function createFlattenObservable<T>(
	source: Subject<Promise<T> | Observable<T>>,
	behavior: derivedAsyncBehavior,
): Observable<T> {
	const KEY_OPERATOR_MAP = {
		merge: mergeAll,
		concat: concatAll,
		exhaust: exhaustAll,
		switch: switchAll,
	};

	return source.pipe(KEY_OPERATOR_MAP[behavior]());
}

function isPromise<T>(value: any): value is Promise<T> {
	return value && typeof value.then === 'function';
}

const enum StateKind {
	NoValue,
	Value,
	Error,
}

interface NoValueState {
	kind: StateKind.NoValue;
}

interface ValueState<T> {
	kind: StateKind.Value;
	value: T;
}

interface ErrorState {
	kind: StateKind.Error;
	error: unknown;
}

type State<T> = NoValueState | ValueState<T> | ErrorState;
