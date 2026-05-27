export interface MergeResult {
	text: string;
	conflicts: number;
}

function lcsTable(a: string[], b: string[]): number[][] {
	const m = a.length, n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}
	return dp;
}

function lcsIndices(a: string[], b: string[]): Array<[number, number]> {
	const dp = lcsTable(a, b);
	const matches: Array<[number, number]> = [];
	let i = a.length, j = b.length;
	while (i > 0 && j > 0) {
		if (a[i - 1] === b[j - 1]) {
			matches.unshift([i - 1, j - 1]);
			i--; j--;
		} else if (dp[i - 1][j] >= dp[i][j - 1]) {
			i--;
		} else {
			j--;
		}
	}
	return matches;
}

/**
 * 2-way line merge using LCS as a synthetic base.
 * Non-overlapping insertions/deletions are auto-merged.
 * Overlapping changes produce conflict markers.
 */
export function merge2way(local: string, remote: string): MergeResult {
	const localLines = local.split("\n");
	const remoteLines = remote.split("\n");

	const matches = lcsIndices(localLines, remoteLines);
	// Sentinel to simplify boundary logic
	matches.push([localLines.length, remoteLines.length]);

	const out: string[] = [];
	let conflicts = 0;
	let li = 0, ri = 0;

	for (const [lm, rm] of matches) {
		const localGap = localLines.slice(li, lm);
		const remoteGap = remoteLines.slice(ri, rm);

		if (localGap.length === 0 && remoteGap.length === 0) {
			// nothing to do
		} else if (localGap.length === 0) {
			// only remote added lines
			out.push(...remoteGap);
		} else if (remoteGap.length === 0) {
			// only local added lines
			out.push(...localGap);
		} else {
			// both sides changed — conflict
			conflicts++;
			out.push("<<<<<<< Local");
			out.push(...localGap);
			out.push("=======");
			out.push(...remoteGap);
			out.push(">>>>>>> Remote");
		}

		if (lm < localLines.length) {
			out.push(localLines[lm]);
		}
		li = lm + 1;
		ri = rm + 1;
	}

	return { text: out.join("\n"), conflicts };
}
