import { address } from "./solidityTypes";
import { TokenPaymaster } from "./../typechain/contracts/samples/TokenPaymaster";
import { SimpleAccount } from "./../typechain/contracts/samples/SimpleAccount";
import { Wallet } from "ethers";
import { ethers } from "hardhat";
import { expect } from "chai";
import {
  SimpleAccountFactory__factory,
  TestUtil,
  TestUtil__factory,
} from "../typechain";
import {
  createAddress,
  createAccountOwner,
  getBalance,
  isDeployed,
  ONE_ETH,
  createAccount,
  HashZero,
} from "./testutils";
import {
  fillUserOpDefaults,
  getUserOpHash,
  packUserOp,
  signUserOp,
} from "./UserOp";
import { parseEther } from "ethers/lib/utils";
import { UserOperation } from "./UserOperation";

describe("SimpleAccount", async function () {
  const entryPoint = "0x".padEnd(42, "2");

  let accounts: string[];
  let testUtil: TestUtil;
  let accountOwner: Wallet;
  const ethersSigner = ethers.provider.getSigner();
  // console.log(await ethersSigner);

  before(async function () {
    accounts = await ethers.provider.listAccounts();
    console.log(`Account Variable Length: ${accounts.length} Addresses`);
    // ignore in geth.. this is just a sanity test. should be refactored to use a single-account mode..
    if (accounts.length < 2) this.skip();
    testUtil = await new TestUtil__factory(ethersSigner).deploy();

    accountOwner = createAccountOwner();
    console.log(`Account Owner Address: ${accountOwner.address}`);
  });

  it("owner should be able to call transfer", async () => {
    const { proxy: account } = await createAccount(
      ethers.provider.getSigner(),
      accounts[0],
      entryPoint
    );
    console.log(`Account Address: ${account.address}`);

    console.log(`Accounts[0]: ${accounts[0]}`);

    await ethersSigner.sendTransaction({
      from: accounts[0],
      to: account.address,
      value: parseEther("2"),
    });
    await account.execute(accounts[2], ONE_ETH, "0x");
  });

  it("Should send Homemade Tokens from the Contract to another User", async () => {
    const { proxy: account } = await createAccount(
      ethers.provider.getSigner(),
      accounts[0],
      entryPoint
    );
  });

  it("other account should not be able to call transfer", async () => {
    const { proxy: account } = await createAccount(
      ethers.provider.getSigner(),
      accounts[0],
      entryPoint
    );
    await expect(
      account
        .connect(ethers.provider.getSigner(1))
        .execute(accounts[2], ONE_ETH, "0x")
    ).to.be.revertedWith("account: not Owner or EntryPoint");
  });

  it("change the owner", async () => {
    const { proxy: account } = await createAccount(
      ethers.provider.getSigner(),
      accounts[0],
      entryPoint
    );
    console.log(`Previous Owner was: ${await account.owner()}`);

    await account
      .connect(ethers.provider.getSigner())
      .changeOwner("0xbCA486a10C2207B98f60F66Ff8E46fC1a33A5D10");

    console.log(`New Owner is: ${await account.owner()}`);
  });

  it("should pack in js the same as solidity", async () => {
    const op = await fillUserOpDefaults({ sender: accounts[0] });
    console.log("\x1b[31m", `Op Object is: ${JSON.stringify(op, null, " ")}`);
    // console.table([op]);

    const packed = packUserOp(op);
    // console.log(`Packed Op Object is: ${JSON.stringify(packed)}`);

    expect(await testUtil.packUserOp(op)).to.equal(packed);
  });

  describe("#validateUserOp", () => {
    let account: SimpleAccount;
    let userOp: UserOperation;
    let userOpHash: string;
    let preBalance: number;
    let expectedPay: number;

    const actualGasPrice = 1e9;

    before(async () => {
      // that's the account of ethersSigner
      // const entryPoint = accounts[2];
      const entryPoint = accounts[4];
      ({ proxy: account } = await createAccount(
        await ethers.getSigner(entryPoint),
        accountOwner.address,
        entryPoint
      ));
      await ethersSigner.sendTransaction({
        from: accounts[0],
        to: account.address,
        value: parseEther("0.2"),
      });
      const callGasLimit = 200000;
      const verificationGasLimit = 100000;
      const maxFeePerGas = 3e9;
      const chainId = await ethers.provider
        .getNetwork()
        .then((net) => net.chainId);

      // An ABI can be fragments and does not have to include the entire interface.
      // As long as it includes the parts we want to use.
      const partialERC20TokenABI = [
        "function transfer(address to, uint amount) returns (bool)",
      ];
      const erc20Token = new ethers.utils.Interface(partialERC20TokenABI);

      const data = account.encodeFunctionData("execute", [
        account.address,
        ethers.constants.Zero,
        erc20Token.encodeFunctionData("transfer", [account.address, 20]),
      ]);

      userOp = signUserOp(
        fillUserOpDefaults({
          sender: account.address,
          callData: data,
          callGasLimit,
          verificationGasLimit,
          maxFeePerGas,
        }),
        accountOwner,
        entryPoint,
        chainId
      );

      console.log(
        "\x1b[33m",
        `UserOp Object is: ${JSON.stringify(userOp, null, " ")}`
      );

      userOpHash = await getUserOpHash(userOp, entryPoint, chainId);

      expectedPay = actualGasPrice * (callGasLimit + verificationGasLimit);

      preBalance = await getBalance(account.address);
      const ret = await account.validateUserOp(
        userOp,
        userOpHash,
        expectedPay,
        { gasPrice: actualGasPrice }
      );
      await ret.wait();
    });

    it("should pay", async () => {
      const postBalance = await getBalance(account.address);
      expect(preBalance - postBalance).to.eql(expectedPay);
    });

    it("should increment nonce", async () => {
      expect(await account.nonce()).to.equal(1);
    });

    it("should reject same TX on nonce error", async () => {
      await expect(
        account.validateUserOp(userOp, userOpHash, 0)
      ).to.revertedWith("invalid nonce");
    });

    it("should return NO_SIG_VALIDATION on wrong signature", async () => {
      const userOpHash = HashZero;
      const deadline = await account.callStatic.validateUserOp(
        { ...userOp, nonce: 1 },
        userOpHash,
        0
      );
      expect(deadline).to.eq(1);
    });
  });
  context("SimpleAccountFactory", () => {
    it("sanity: check deployer", async () => {
      const ownerAddr = createAddress();
      const deployer = await new SimpleAccountFactory__factory(
        ethersSigner
      ).deploy(entryPoint);
      const target = await deployer.callStatic.createAccount(ownerAddr, 1234);
      expect(await isDeployed(target)).to.eq(false);
      await deployer.createAccount(ownerAddr, 1234);
      expect(await isDeployed(target)).to.eq(true);
    });
  });
});
