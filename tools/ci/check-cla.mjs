import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const githubBotLoginPattern = /\[bot\]$/i

function normalize(value) {
	return value.trim().toLowerCase()
}

function identityLabel(identity) {
	if (identity.githubLogin) {
		return `@${identity.githubLogin}`
	}
	if (identity.email) {
		return identity.email
	}
	if (identity.name) {
		return identity.name
	}
	return 'unknown identity'
}

export function parseClaSignersFile(raw) {
	const parsed = JSON.parse(raw)
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		parsed.version !== 1
	) {
		throw new Error('CLA signers file must be version 1 JSON')
	}
	if (
		typeof parsed.document !== 'string' ||
		typeof parsed.allowlist !== 'object' ||
		parsed.allowlist === null ||
		!Array.isArray(parsed.allowlist.github) ||
		!Array.isArray(parsed.allowlist.email) ||
		!Array.isArray(parsed.signers)
	) {
		throw new Error('CLA signers file is missing allowlist or signers')
	}
	return parsed
}

export function isAllowlistedIdentity(identity, signersFile) {
	const login = identity.githubLogin ? normalize(identity.githubLogin) : null
	if (
		login &&
		(githubBotLoginPattern.test(login) || login.startsWith('app/'))
	) {
		return true
	}
	if (
		login &&
		signersFile.allowlist.github.some((entry) => normalize(entry) === login)
	) {
		return true
	}
	const email = identity.email ? normalize(identity.email) : null
	return Boolean(
		email &&
			signersFile.allowlist.email.some((entry) => normalize(entry) === email),
	)
}

export function hasSignedCla(identity, signersFile) {
	const login = identity.githubLogin ? normalize(identity.githubLogin) : null
	if (!login) {
		return false
	}
	return signersFile.signers.some(
		(signer) => normalize(signer.github) === login,
	)
}

export function checkClaIdentities(identities, signersFile) {
	const missing = []
	const seen = new Set()
	for (const identity of identities) {
		const key = [identity.githubLogin, identity.email, identity.name]
			.map((part) => (part ? normalize(part) : ''))
			.join('|')
		if (seen.has(key)) {
			continue
		}
		seen.add(key)
		if (isAllowlistedIdentity(identity, signersFile)) {
			continue
		}
		if (hasSignedCla(identity, signersFile)) {
			continue
		}
		const reason = identity.githubLogin
			? `${identityLabel(identity)} has not signed the CLA`
			: `${identityLabel(identity)} has no GitHub login and is not a Licensor email`
		missing.push({ identity, reason })
	}
	return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

export function formatClaFailure(result) {
	return [
		'Unsigned contributions cannot merge.',
		'Read docs/legal/individual-cla.md (or the Entity CLA if an organization owns the work).',
		'Comment on the pull request: I have read the CLA and I hereby sign the CLA',
		'A maintainer then records your GitHub username on main. See the inbound contributions doc.',
		'',
		'Missing signatures:',
		...result.missing.map((entry) => `- ${entry.reason}`),
	].join('\n')
}

function runSelfTest() {
	const file = {
		version: 1,
		document: 'docs/legal/individual-cla.md',
		allowlist: {
			github: ['kentcdodds', 'kody-bot'],
			email: ['me@kentcdodds.com', 'me+github@kentcdodds.com'],
		},
		signers: [
			{ github: 'VojtaHolik', signedAt: '2026-08-16', cla: 'individual' },
		],
	}
	const passing = checkClaIdentities(
		[
			{ githubLogin: 'kentcdodds', name: 'Kent', email: null },
			{ githubLogin: 'kody-bot', name: 'Kody', email: null },
			{ githubLogin: 'cursor[bot]', name: 'cursor[bot]', email: null },
			{ githubLogin: 'app/imgbot', name: 'ImgBot', email: null },
			{
				githubLogin: null,
				name: 'Kent C. Dodds',
				email: 'me+github@kentcdodds.com',
			},
			{
				githubLogin: 'vojtaholik',
				name: 'Vojta Holik',
				email: 'vojta@egghead.io',
			},
		],
		file,
	)
	if (!passing.ok) {
		throw new Error('expected allowlisted and signed identities to pass')
	}
	const failing = checkClaIdentities(
		[
			{ githubLogin: 'kentcdodds', name: 'Kent', email: null },
			{
				githubLogin: 'someone-else',
				name: 'Someone',
				email: 'someone@example.com',
			},
			{
				githubLogin: null,
				name: 'Someone',
				email: 'someone@example.com',
			},
		],
		file,
	)
	if (failing.ok) {
		throw new Error('expected unsigned identities to fail')
	}
	const reasons = failing.missing.map((entry) => entry.reason)
	if (
		reasons[0] !== '@someone-else has not signed the CLA' ||
		reasons[1] !==
			'someone@example.com has no GitHub login and is not a Licensor email'
	) {
		throw new Error(`unexpected failure reasons: ${reasons.join('; ')}`)
	}
	console.log('CLA self-test passed')
}

async function runCli(args) {
	if (args.includes('--self-test')) {
		runSelfTest()
		return
	}
	const signersFlag = args.indexOf('--signers')
	const identitiesFlag = args.indexOf('--identities-json')
	const signersPath = signersFlag === -1 ? null : args[signersFlag + 1]
	const identitiesPath =
		identitiesFlag === -1 ? null : args[identitiesFlag + 1]
	if (!signersPath || !identitiesPath) {
		throw new Error(
			'Usage: node tools/ci/check-cla.mjs --signers <file> --identities-json <file>',
		)
	}
	const signersFile = parseClaSignersFile(await readFile(signersPath, 'utf8'))
	const identitiesRaw = JSON.parse(await readFile(identitiesPath, 'utf8'))
	if (!Array.isArray(identitiesRaw)) {
		throw new Error('Identities JSON must be an array')
	}
	const result = checkClaIdentities(identitiesRaw, signersFile)
	if (!result.ok) {
		console.error(formatClaFailure(result))
		process.exitCode = 1
	}
}

const entryPoint = process.argv[1]
if (
	entryPoint &&
	pathToFileURL(path.resolve(entryPoint)).href === import.meta.url
) {
	await runCli(process.argv.slice(2))
}
