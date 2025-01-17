const { expect, constants, time, ether } = require('@1inch/solidity-utils');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { ethers } = require('hardhat');
const { almostEqual, startFarming, joinNewFarms } = require('./utils');

require('chai').use(function (chai, utils) {
    chai.Assertion.overwriteMethod('almostEqual', (original) => {
        return function (value) {
            const expected = BigInt(value);
            const actual = BigInt(this._obj);
            almostEqual.apply(this, [expected, actual]);
        };
    });
});

describe('FarmingPod', function () {
    let wallet1, wallet2, wallet3;
    const INITIAL_SUPPLY = ether('1');
    const MAX_USER_FARMS = 10;
    const MAX_POD_GAS_LIMIT = 200_000;

    before(async function () {
        [wallet1, wallet2, wallet3] = await ethers.getSigners();
    });

    async function initContracts () {
        const ERC20FarmableMock = await ethers.getContractFactory('ERC20PodsMock');
        const token = await ERC20FarmableMock.deploy('1INCH', '1INCH', MAX_USER_FARMS, MAX_POD_GAS_LIMIT);
        await token.deployed();
        await token.mint(wallet1.address, INITIAL_SUPPLY);

        const TokenMock = await ethers.getContractFactory('TokenMock');
        const gift = await TokenMock.deploy('UDSC', 'USDC');
        await gift.deployed();
        const FarmingPod = await ethers.getContractFactory('FarmingPod');
        const farm = await FarmingPod.deploy(token.address, gift.address);
        await farm.deployed();

        for (const wallet of [wallet1, wallet2, wallet3]) {
            await gift.mint(wallet.address, '1000000000');
            await gift.connect(wallet).approve(farm.address, '1000000000');
        }
        await farm.setDistributor(wallet1.address);
        return { token, gift, farm };
    };

    // Generic farming scenarios
    describe('farming', function () {
        // Farm initialization scenarios
        describe('startFarming', function () {
            /*
                ***Test Scenario**
                Checks that only distributors may launch farming. "Distributor" is the only account that offers a farming reward.
                ***Initial setup**
                - `wallet1` - distributor account
                - `wallet2` - non-distributor account

                ***Test Steps**
                Start farming using `wallet2`
                ***Expected results**
                Revert with error `'AccessDenied()'`.
            */
            it('should thrown with rewards distribution access denied ', async function () {
                const { farm } = await loadFixture(initContracts);
                await expect(
                    farm.connect(wallet2).startFarming(1000, 60 * 60 * 24),
                ).to.be.revertedWithCustomError(farm, 'AccessDenied');
            });

            /*
                ***Test Scenario**
                Checks that the farming period is of `uint40` size.

                ***Test Steps**
                Start farming using 2^40^ as the farming period.

                ***Expected results**
                Revert with error `'DurationTooLarge()'`.
            */
            it('Thrown with Period too large', async function () {
                const { farm } = await loadFixture(initContracts);
                await expect(
                    farm.startFarming('10000', 2n ** 40n),
                ).to.be.revertedWithCustomError(farm, 'DurationTooLarge');
            });

            /*
                ***Test Scenario**
                Checks that the farming amount is under _MAX_REWARD_AMOUNT

                ***Test Steps**
                Start farming using _MAX_REWARD_AMOUNT+1 as a farming reward.

                ***Expected results**
                Revert with error `'AmountTooLarge()'`.
            */
            it('Thrown with Amount equals _MAX_REWARD_AMOUNT + 1', async function () {
                const { gift, farm } = await loadFixture(initContracts);
                const _MAX_REWARD_AMOUNT = 10n ** 42n;
                await gift.mint(wallet1.address, _MAX_REWARD_AMOUNT + 1n);
                await gift.approve(farm.address, _MAX_REWARD_AMOUNT + 1n);
                await expect(
                    farm.startFarming(_MAX_REWARD_AMOUNT + 1n, time.duration.weeks(1)),
                ).to.be.revertedWithCustomError(farm, 'AmountTooLarge');
            });

            it('should show farming parameters', async function () {
                const { token, farm } = await loadFixture(initContracts);
                await token.addPod(farm.address);

                const duration = 60 * 60 * 24;
                const reward = 1000;

                const started = await startFarming(farm, reward, duration, wallet1);

                const farmInfo = await farm.farmInfo();

                expect(farmInfo.duration).to.be.equal(duration);
                expect(farmInfo.finished).to.be.equal(started + duration);
                expect(farmInfo.reward).to.be.equal(reward);
            });
        });

        // Token's claim scenarios
        describe('claim', function () {
            /*
                ***Test Scenario**
                Checks that farming reward can be claimed with the regular scenario 'join - farm - claim'.
                ***Initial setup**
                - `farm` started farming for 1 day with 1000 units reward
                - `wallet1` has 1000 farmable tokens and has joined the farm

                ***Test Steps**
                1. Fast-forward time to 1 day and 1 hour
                2. Claim reward for `wallet1`

                ***Expected results**
                `wallet1` reward token balance equals 1000
            */
            it('should claim tokens', async function () {
                const { token, gift, farm } = await loadFixture(initContracts);
                await token.addPod(farm.address);

                const started = await startFarming(farm, 1000, 60 * 60 * 24, wallet1);
                await time.increaseTo(started + 60 * 60 * 25);

                const balanceBefore = await gift.balanceOf(wallet1.address);
                await farm.claim();
                expect(await gift.balanceOf(wallet1.address)).to.equal(balanceBefore.add(1000));
            });

            /*
                ***Test Scenario**
                Checks that non-farming wallet doesn't get a reward
                ***Initial setup**
                - `farm` started farming for 1 day with 1000 units reward
                - `wallet1` has 1000 farmable tokens and joined the farm
                - `wallet2` hasn't joined the farm

                ***Test Steps**
                1. Fast-forward time to 1 day and 1 hour
                2. Claim reward for `wallet2`

                ***Expected results**
                `wallet2` gift token balance doesn't change after the claim
            */
            it('should claim tokens for non-user farms wallet', async function () {
                const { token, gift, farm } = await loadFixture(initContracts);
                await token.addPod(farm.address);

                const started = await startFarming(farm, 1000, 60 * 60 * 24, wallet1);
                await time.increaseTo(started + 60 * 60 * 25);

                const balanceBefore = await gift.balanceOf(wallet2.address);
                await farm.claim();
                expect(await gift.balanceOf(wallet2.address)).to.equal(balanceBefore);
            });
        });

        // Farm's claim scenarios
        describe('claim', function () {
            /*
                ***Test Scenario**
                Checks that farming rewards can be claimed from all user's farms with the regular scenario 'join - farm - claim'.

                ***Initial setup**
                - 10 farms have been created and set up
                - All `farms` have started farming for 1 day with 100 units reward for each
                - `wallet1` has 1000 farmable tokens and has joined 10 farms
                - `wallet1` has no reward tokens

                ***Test Steps**
                1. Fast-forward time to finish all farmings (1 day)
                2. `wallet1` claims rewards from all farms using the `claimAll` function

                ***Expected results**
                `wallet1` reward token balance equals 1000
            */
            it('should claim tokens from all farms', async function () {
                const { token, gift } = await loadFixture(initContracts);
                // Create and set additional farms
                const farmsCount = 10;
                const farms = [];
                let lastFarmStarted;
                const FarmingPod = await ethers.getContractFactory('FarmingPod');
                for (let i = 0; i < farmsCount; i++) {
                    farms[i] = await FarmingPod.deploy(token.address, gift.address);
                    await farms[i].deployed();
                    await farms[i].setDistributor(wallet1.address);
                }

                // Join and start farming, then delay
                for (let i = 0; i < farmsCount; i++) {
                    await token.addPod(farms[i].address);
                    await gift.approve(farms[i].address, '100');
                    lastFarmStarted = await startFarming(farms[i], 100, time.duration.days(1), wallet1);
                }
                await time.increaseTo(lastFarmStarted + time.duration.days(1));

                // Check reward
                const balanceBefore = await gift.balanceOf(wallet1.address);
                await Promise.all(farms.map(farm => farm.claim()));
                expect(await gift.balanceOf(wallet1.address)).to.equal(balanceBefore.add(1000));
            });
        });

        // Farm's rescueFunds scenarios
        describe('rescueFunds', function () {
            /*
                ***Test Scenario**
                Ensures that a non-distributor account cannot call the `rescueFunds` function to get all remaining funds from the farm.

                ***Initial setup**
                - `wallet2` is not a distributor

                ***Test Steps**
                - `wallet2` calls `rescueFunds` function

                ***Expected results**
                - Call is reverted with an error `'AccessDenied()'`
            */
            it('should thrown with access denied', async function () {
                const { gift, farm } = await loadFixture(initContracts);
                const distributor = await farm.distributor();
                expect(wallet2.address).to.not.equal(distributor);
                await expect(
                    farm.connect(wallet2).rescueFunds(gift.address, '1000'),
                ).to.be.revertedWithCustomError(farm, 'AccessDenied');
            });

            /*
                ***Test Scenario**
                Ensures that a distributor account can get remaining funds from the farm using the `rescueFunds` function.

                ***Initial setup**
                - A farm has started farming

                ***Test Steps**
                - Distributor calls the `rescueFunds` function to transfer 1000 reward tokens from the farm to its account
                - Check the balances of the distributor's account and the farm's accounts

                ***Expected results**
                - 1000 reward tokens are transferred from the farm to the distributor
            */
            it('should transfer tokens from farm to wallet', async function () {
                const { gift, farm } = await loadFixture(initContracts);
                await farm.startFarming(1000, 60 * 60 * 24);

                const balanceWalletBefore = await gift.balanceOf(wallet1.address);
                const balanceFarmBefore = await gift.balanceOf(farm.address);

                const distributor = await farm.distributor();
                expect(wallet1.address).to.equal(distributor);
                await farm.rescueFunds(gift.address, '1000');

                expect(await gift.balanceOf(wallet1.address)).to.equal(balanceWalletBefore.add(1000));
                expect(await gift.balanceOf(farm.address)).to.equal(balanceFarmBefore.sub(1000));
            });

            /*
                ***Test Scenario**
                Ensure that `rescueFunds` can transfer ether to a distributor

                ***Initial setup**
                - A farm has been set up and ether has been transferred to the farm

                ***Test Steps**
                - Call `rescueFunds` function to get 1000 ethers
                - Calculate rescueFunds blockchain fee

                ***Expected results**
                - `wallet1` balance has increased by 1000 ethers minus the blockchain fee
            */
            it('should transfer ethers from farm to wallet', async function () {
                const { farm } = await loadFixture(initContracts);
                // Transfer ethers to farm
                const EthTransferMock = await ethers.getContractFactory('EthTransferMock');
                const ethMock = await EthTransferMock.deploy(farm.address, { value: '1000' });
                await ethMock.deployed();

                // Check rescueFunds
                const balanceWalletBefore = await ethers.provider.getBalance(wallet1.address);
                const balanceFarmBefore = await ethers.provider.getBalance(farm.address);

                const distributor = await farm.distributor();
                expect(wallet1.address).to.equal(distributor);
                const tx = await farm.rescueFunds(constants.ZERO_ADDRESS, '1000');
                const receipt = await tx.wait();
                const txCost = receipt.gasUsed * receipt.effectiveGasPrice;

                expect(await ethers.provider.getBalance(wallet1.address)).to.equal(balanceWalletBefore.sub(txCost).add(1000));
                expect(await ethers.provider.getBalance(farm.address)).to.equal(balanceFarmBefore.sub(1000));
            });
        });

        // Farm's pods scenarios
        describe('hasPod', function () {
            /*
                ***Test Scenario**
                Ensures that the `hasPod` view returns the correct farming status

                ***Initial setup**
                - `wallet1` has not joined a farm
                - `wallet2` has joined a farm

                ***Test Steps**
                - Check if `wallet1` and `wallet2` are farming

                ***Expected results**
                - `wallet1` status: is not farming (false)
                - `wallet2` status: is farming (true)
            */
            it('should return false when user does not farm and true when user farms', async function () {
                const { token, farm } = await loadFixture(initContracts);
                await token.connect(wallet2).addPod(farm.address);
                expect(await token.hasPod(wallet1.address, farm.address)).to.equal(false);
                expect(await token.hasPod(wallet2.address, farm.address)).to.equal(true);
            });

            /*
                ***Test Scenario**
                Ensures that `hasPod` returns the correct farming status after `quit` is called

                ***Test Steps**
                - `wallet2` joins to farm
                - `wallet2` quits from farm

                ***Expected results**
                - `wallet2` status: is not farming (false)
            */
            it('should return false when user quits from farm', async function () {
                const { token, farm } = await loadFixture(initContracts);
                await token.connect(wallet2).addPod(farm.address);
                await token.connect(wallet2).removePod(farm.address);
                expect(await token.hasPod(wallet1.address, farm.address)).to.equal(false);
            });
        });

        describe('podsCount', function () {
            /*
                ***Test Scenario**
                Ensures that the `podsCount` view returns the correct amount of user's farms

                ***Test Steps**
                1. Account joins to N farms
                2. Account quits from N farms

                ***Expected results**
                - Each time the account joins a farm `podsCount` should increase by 1
                - Each time the account quits from a farm `podsCount` should decrease by 1
            */
            it('should return amount of user\'s farms', async function () {
                const { token } = await loadFixture(initContracts);
                const farmsCount = 10;
                await joinNewFarms(token, farmsCount, wallet1);
                expect(await token.podsCount(wallet1.address)).to.equal(farmsCount);

                const farms = await token.pods(wallet1.address);
                expect(farms.length).to.equal(farmsCount);
                for (let i = 0; i < farmsCount; i++) {
                    await token.removePod(farms[i]);
                    expect(await token.podsCount(wallet1.address)).to.equal(farmsCount - i - 1);
                }
            });
        });

        describe('podAt', function () {
            /*
                ***Test Scenario**
                Ensure that the `podAt` view returns the correct farm by index

                ***Initial setup**
                - Account joins an array of farms

                ***Test Steps**
                1. Call `pods` view to get an array of joined farms for the account
                2. Request each farm's address with `podAt` view and compare it with the farm's address in the array

                ***Expected results**
                - Each pair of addresses should be equal
            */
            it('should return correct addresses', async function () {
                const { token } = await loadFixture(initContracts);
                const farmsCount = 10;
                await joinNewFarms(token, farmsCount, wallet1);
                const farms = await token.pods(wallet1.address);
                for (let i = 0; i < farmsCount; i++) {
                    const farmAddress = await token.podAt(wallet1.address, i);
                    expect(farmAddress).to.equal(farms[i]);
                }
            });
        });
    });

    // Wallet joining scenarios
    describe('totalSupply', function () {
        /*
            ***Test Scenario**
            Checks if farm's total supply is updated after a wallet joins

            ***Initial setup**
            - `wallet1` has 1000 unit of farmable token but has not joined the farm

            ***Test Steps**
            `wallet1` joins the farm

            ***Expected results**
            Farm's total supply equals 1000
        */
        it('should update totalSupply', async function () {
            const { token, farm } = await loadFixture(initContracts);
            await token.addPod(farm.address);
            expect(await farm.totalSupply()).to.equal(INITIAL_SUPPLY);
        });

        /*
            ***Test Scenario**
            Checks if farm's total supply is decreased after a wallet balance decreased
            ***Initial setup**
            - `wallet1` has 1000 unit of farmable token and joined the farm
            - `wallet2` has no farmable token and hasn't joined the farm

            ***Test Steps**
            Transfer 600 units from `wallet1` to `wallet2`
            ***Expected results**
            Farm's total supply decreased and equals to 400
        */
        it('should make totalSupply to decrease with balance', async function () {
            const { token, farm } = await loadFixture(initContracts);
            await token.addPod(farm.address);
            await token.transfer(wallet2.address, INITIAL_SUPPLY * 6n / 10n);
            expect(await farm.totalSupply()).to.equal(INITIAL_SUPPLY * 4n / 10n);
        });

        /*
            ***Test Scenario**
            Checks if farm's total supply is increased after a wallet balance increased
            ***Initial setup**
            - `wallet1` has 1000 unit of farmable token and joined the farm
            - `wallet2` has 1000 unit of farmable token and hasn't joined the farm

            ***Test Steps**
            Transfer 500 units from `wallet2` to `wallet1`
            ***Expected results**
            Farm's total supply increased and equals to 1500
        */
        it('should make totalSupply to increase with balance', async function () {
            const { token, farm } = await loadFixture(initContracts);
            await token.transfer(wallet2.address, INITIAL_SUPPLY / 2n);
            await token.addPod(farm.address);
            expect(await farm.totalSupply()).to.equal(INITIAL_SUPPLY / 2n);
            await token.connect(wallet2).transfer(wallet1.address, INITIAL_SUPPLY / 2n);
            expect(await farm.totalSupply()).to.equal(INITIAL_SUPPLY);
        });

        /*
            ***Test Scenario**
            Checks if farm's total supply is unchaged after a transfer between farming wallets
            ***Initial setup**
            - `wallet1` has 1000 unit of farmable token and joined the farm
            - `wallet2` has 1000 unit of farmable token and joined the farm

            ***Test Steps**
            Transfer 500 units from `wallet1` to `wallet2`
            ***Expected results**
            Farm's total supply remains unchanged and equals to 400
        */
        it('should make totalSupply ignore internal transfers', async function () {
            const { token, farm } = await loadFixture(initContracts);
            await token.addPod(farm.address);
            await token.connect(wallet2).addPod(farm.address);
            expect(await farm.totalSupply()).to.equal(INITIAL_SUPPLY);
            await token.transfer(wallet2.address, INITIAL_SUPPLY / 2n);
            expect(await farm.totalSupply()).to.equal(INITIAL_SUPPLY);
        });

        /*
            ***Test Scenario**
            Checks that farm's total supply decreases after a user removePods farming

            ***Initial setup**
            - `farm` has not started farming
            - `wallet1` has 1000 unit of farmable token and joined the `farm`

            ***Test Steps**
            `wallet1` removePods the `farm`

            ***Expected results**
            Farm's total supply equals 0
        */
        it('should be burn', async function () {
            const { token, farm } = await loadFixture(initContracts);
            await token.addPod(farm.address);
            await token.removePod(farm.address);
            expect(await farm.totalSupply()).to.equal('0');
        });
    });

    // Farming reward calculations scenarios
    describe('deposit', function () {
        /*
            ***Test Scenario**
            Staker without farming tokens joins on 1st week and adds them on 2nd
            ```
            72k => 1x: +       +-------+ => 36k
            ```

            ***Initial setup**
            - `farm` has started farming **72k** for **2 weeks**
            - `wallet1` has no farmable token and joined the `farm`

            ***Test Steps**
            1. Fast-forward to 1 week end
            2. `wallet1` gets farming tokens
            3. Fast-forward to 2 week

            ***Expected results**
            After step 1 - farmed reward = 0
            After step 3 - farmed reward = 36k
        */
        it('Staker w/o tokens joins on 1st week and adds token on 2nd', async function () {
            const { token, farm } = await loadFixture(initContracts);
            const started = await startFarming(farm, '72000', time.duration.weeks(2), wallet1);
            expect(await farm.farmed(wallet2.address)).to.equal('0');

            await token.connect(wallet2).addPod(farm.address);
            expect(await farm.farmed(wallet2.address)).to.equal('0');

            await time.increaseTo(started + time.duration.weeks(1));
            expect(await farm.farmed(wallet1.address)).to.equal('0');

            await token.transfer(wallet2.address, INITIAL_SUPPLY);
            await time.increaseTo(started + time.duration.weeks(2));
            expect(await farm.farmed(wallet2.address)).to.almostEqual('36000');
        });

        /*
            ***Test Scenario**
            Two stakers with the same stakes wait 1w
            ```
            72k => 1x: +-------+  => 36k
            #      1x: +-------+  => 36k
            ```

            ***Initial setup**
            - `farm` has started farming **72k** for **1 week**
            - `wallet1` has 1 farmable token and joined the `farm`
            - `wallet2` has 1 farmable token and joined the `farm`

            ***Test Steps**
            Fast-forward to week 1 end

            ***Expected results**
            `wallet1` farmed reward is 36k
            `wallet2` farmed reward is 36k
        */
        it('Two stakers with the same stakes wait 1 w', async function () {
            const { token, farm } = await loadFixture(initContracts);
            await token.transfer(wallet2.address, INITIAL_SUPPLY / 2n);

            // 72000 UDSC per week for 3 weeks
            const started = await startFarming(farm, '72000', time.duration.weeks(1), wallet1);

            // expect(await token.farmedPerToken()).to.equal('0');
            expect(await farm.farmed(wallet1.address)).to.equal('0');
            expect(await farm.farmed(wallet2.address)).to.equal('0');

            await token.addPod(farm.address);
            await token.connect(wallet2).addPod(farm.address);

            // expect(await token.farmedPerToken()).to.equal('0');
            expect(await farm.farmed(wallet1.address)).to.equal('0');
            expect(await farm.farmed(wallet2.address)).to.equal('0');

            await time.increaseTo(started + time.duration.weeks(1));

            // expect(await token.farmedPerToken()).to.almostEqual('36000');
            expect(await farm.farmed(wallet1.address)).to.almostEqual('36000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('36000');
        });

        /*
            ***Test Scenario**
            Two stakers with the same stakes wait 1w
            ```
            72k => 1x: +-------+  => 18k
            #      3x: +-------+  => 54k
            ```

            ***Initial setup**
            - `farm` has started farming **72k** for **1 week**
            - `wallet1` has 1 farmable token and joined the `farm`
            - `wallet2` has 3 farmable token and joined the `farm`

            ***Test Steps**
            Fast-forward to week 1 end

            ***Expected results**
            `wallet1` farmed reward is 18k
            `wallet2` farmed reward is 54k
        */
        it('Two stakers with the different (1:3) stakes wait 1 w', async function () {
            const { token, farm } = await loadFixture(initContracts);
            await token.transfer(wallet2.address, INITIAL_SUPPLY / 4n);

            // 72000 UDSC per week
            const started = await startFarming(farm, '72000', time.duration.weeks(1), wallet1);

            // expect(await token.farmedPerToken()).to.equal('0');
            expect(await farm.farmed(wallet1.address)).to.equal('0');
            expect(await farm.farmed(wallet2.address)).to.equal('0');

            await token.addPod(farm.address);
            await token.connect(wallet2).addPod(farm.address);

            // expect(await token.farmedPerToken()).to.equal('0');
            expect(await farm.farmed(wallet1.address)).to.equal('0');
            expect(await farm.farmed(wallet2.address)).to.equal('0');

            await time.increaseTo(started + time.duration.weeks(1));

            // expect(await token.farmedPerToken()).to.almostEqual('18000');
            expect(await farm.farmed(wallet1.address)).to.almostEqual('54000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('18000');
        });

        /*
            ***Test Scenario**
            Two stakers with the different (1:3) stakes wait 2 weeks
            ```
            72k => 1x: +--------+ 72k => 1x: +--------+ => 72k for 1w + 18k for 2w
            #      0x:                   3x: +--------+ =>  0k for 1w + 54k for 2w
            ```

            ***Initial setup**
            - `farm` has started farming **72k** for **1 week**
            - `wallet1` has 1 farmable token and joined the `farm`
            - `wallet2` has 3 farmable token and has not joined the `farm`

            ***Test steps and expected rewards**
            |#  |Test Steps|`wallet1`|`wallet2`|
            |---|----------|---------|---------|
            |1. |Fast-forward => **week 1**                 |72k|0|
            |2. |`wallet2` joins the `farm`                 |72k|0|
            |3. |`farm` starts new farming 72k for 1 week   |72k|0|
            |4. |Fast-forward => **week 2**                 |90k|54k|

        */
        it('Two stakers with the different (1:3) stakes wait 2 weeks', async function () {
            const { token, farm } = await loadFixture(initContracts);
            //
            // 1x: +----------------+ = 72k for 1w + 18k for 2w
            // 3x:         +--------+ =  0k for 1w + 54k for 2w
            //
            const recipientAmount = INITIAL_SUPPLY * 3n / 4n;
            await token.transfer(wallet2.address, recipientAmount);

            // 72000 UDSC per week
            const started = await startFarming(farm, '72000', time.duration.weeks(1), wallet1);

            await token.addPod(farm.address);
            expect(await farm.totalSupply()).to.almostEqual(INITIAL_SUPPLY - recipientAmount);

            await time.increaseTo(started + time.duration.weeks(1));

            await token.connect(wallet2).addPod(farm.address);

            // expect(await token.farmedPerToken()).to.almostEqual('72000');
            expect(await farm.farmed(wallet1.address)).to.almostEqual('72000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('0');

            await farm.startFarming('72000', time.duration.weeks(1));
            await time.increaseTo(started + time.duration.weeks(2));

            // expect(await token.farmedPerToken()).to.almostEqual('90000');
            expect(await farm.farmed(wallet1.address)).to.almostEqual('90000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('54000');
        });

        /*
            ***Test Scenario**
            One staker on 1st and 3rd weeks farming with gap
            ```
            72k => 1x: +--------+       72k => 1x: +--------+ = 72k for 1w + 0k for 2w + 72k for 3w
            ```

            ***Initial setup**
            - `farm` has started farming **72k** for **1 week**
            - `wallet1` has 1 farmable token and joined the `farm`

            ***Test steps and expected rewards**
            |#  |Test Steps|`wallet1`|
            |---|----------|---------|
            |1. |Fast-forward => **week 1**                 |72k|
            |2. |Fast-forward => **week 2**                 |72k|
            |3. |`farm` starts new farming 72k for 1 week   |72k|
            |4. |Fast-forward => **week 3**                 |144k|

        */
        it('One staker on 1st and 3rd weeks farming with gap', async function () {
            const { token, farm } = await loadFixture(initContracts);
            //
            // 1x: +-------+        +--------+ = 72k for 1w + 0k for 2w + 72k for 3w
            //

            // 72000 UDSC per week for 1 weeks
            const started = await startFarming(farm, '72000', time.duration.weeks(1), wallet1);

            await token.addPod(farm.address);

            await time.increaseTo(started + time.duration.weeks(1));

            expect(await farm.farmed(wallet1.address)).to.almostEqual('72000');

            await time.increaseTo(started + time.duration.weeks(2));

            // 72000 UDSC per week for 1 weeks
            await farm.startFarming('72000', time.duration.weeks(1));
            await time.increaseTo(started + time.duration.weeks(3));

            expect(await farm.farmed(wallet1.address)).to.almostEqual('144000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('0');
        });

        /*
            ***Test Scenario**
            One staker on 1st and 3rd weeks farming with gap and claims in the middle
            ```
            72k => 1x: +--------+       72k => 1x: +--------+ = 72k for 1w + 0k for 2w + 72k for 3w
            ```

            ***Initial setup**
            - `farm` has started farming **72k** for **1 week**
            - `wallet1` has 1 farmable token and joined the `farm`

            ***Test steps and expected rewards**
            |#  |Test Steps|`wallet1`|
            |---|----------|---------|
            |1. |Fast-forward => **week 1**                 |72k|
            |2. |Claim reward for `wallet1`                 |0  |
            |2. |Fast-forward => **week 2**                 |0|
            |3. |`farm` starts new farming 72k for 1 week   |0|
            |4. |Fast-forward => **week 3**                 |72k|

        */
        it('One staker on 1st and 3rd weeks farming with gap + claim in the middle', async function () {
            const { token, farm } = await loadFixture(initContracts);
            //
            // 1x: +-------+        +--------+ = 72k for 1w + 0k for 2w + 72k for 3w
            //

            // 72000 UDSC per week for 1 weeks
            const started = await startFarming(farm, '72000', time.duration.weeks(1), wallet1);

            await token.addPod(farm.address);

            await time.increaseTo(started + time.duration.weeks(1));

            expect(await farm.farmed(wallet1.address)).to.almostEqual('72000');
            await farm.claim();
            expect(await farm.farmed(wallet1.address)).to.almostEqual('0');

            await time.increaseTo(started + time.duration.weeks(2));

            // 72000 UDSC per week for 1 weeks
            await farm.startFarming('72000', time.duration.weeks(1));
            await time.increaseTo(started + time.duration.weeks(3));

            expect(await farm.farmed(wallet1.address)).to.almostEqual('72000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('0');
        });

        /*
            ***Test Scenario**
            One staker on 1st and 3rd weeks farming with gap and exits and rejoins in the middle
            ```
            72k => 1x: +--------+       72k => 1x: +--------+ = 72k for 1w + 0k for 2w + 72k for 3w
            ```

            ***Initial setup**
            - `farm` has started farming **72k** for **1 week**
            - `wallet1` has 1 farmable token and joined the `farm`

            ***Test steps and expected rewards**
            |#  |Test Steps|`wallet1`|
            |---|----------|---------|
            |1. |Fast-forward => **week 1**                 |72k|
            |2. |`wallet1` removePods `farm`                     |72k|
            |3. |`wallet1` joins `farm`                     |72k|
            |4. |Fast-forward => **week 2**                 |72k|
            |5. |`farm` starts new farming 72k for 1 week   |72k|
            |6. |Fast-forward => **week 3**                 |144k|

        */
        it('One staker on 1st and 3rd weeks farming with gap + exit/farm in the middle', async function () {
            const { token, farm } = await loadFixture(initContracts);
            //
            // 1x: +-------+        +--------+ = 72k for 1w + 0k for 2w + 72k for 3w
            //

            // 72000 UDSC per week for 1 weeks
            const started = await startFarming(farm, '72000', time.duration.weeks(1), wallet1);

            await token.addPod(farm.address);

            await time.increaseTo(started + time.duration.weeks(1));

            expect(await farm.farmed(wallet1.address)).to.almostEqual('72000');
            await token.removePod(farm.address);
            expect(await farm.farmed(wallet1.address)).to.almostEqual('72000');
            await token.addPod(farm.address);
            expect(await farm.farmed(wallet1.address)).to.almostEqual('72000');

            await time.increaseTo(started + time.duration.weeks(2));

            // 72000 UDSC per week for 1 weeks
            await farm.startFarming('72000', time.duration.weeks(1));
            await time.increaseTo(started + time.duration.weeks(3));

            expect(await farm.farmed(wallet1.address)).to.almostEqual('144000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('0');
        });

        /*
            ***Test Scenario**
            One staker on 1st and 3rd weeks farming with gap and exits, claims and rejoins in the middle
            ```
            72k => 1x: +--------+       72k => 1x: +--------+ = 72k for 1w + 0k for 2w + 72k for 3w
            ```

            ***Initial setup**
            - `farm` has started farming **72k** for **1 week**
            - `wallet1` has 1 farmable token and joined the `farm`

            ***Test steps and expected rewards**
            |#  |Test Steps|`wallet1`|
            |---|----------|---------|
            |1. |Fast-forward => **week 1**                 |72k|
            |2. |`wallet1` removePods `farm`                     |72k|
            |3. |`wallet1` claims farming reward            |0k|
            |4. |`wallet1` joins `farm`                     |0k|
            |5. |Fast-forward => **week 2**                 |0k|
            |6. |`farm` starts new farming 72k for 1 week   |72k|
            |7. |Fast-forward => **week 3**                 |72k|

        */
        it('One staker on 1st and 3rd weeks farming with gap + exit/claim in the middle', async function () {
            const { token, farm } = await loadFixture(initContracts);
            //
            // 1x: +-------+        +--------+ = 72k for 1w + 0k for 2w + 72k for 3w
            //

            // 72000 UDSC per week for 1 weeks
            const started = await startFarming(farm, '72000', time.duration.weeks(1), wallet1);

            await token.addPod(farm.address);

            await time.increaseTo(started + time.duration.weeks(1));

            expect(await farm.farmed(wallet1.address)).to.almostEqual('72000');
            await token.removePod(farm.address);
            expect(await farm.farmed(wallet1.address)).to.almostEqual('72000');
            await farm.claim();
            expect(await farm.farmed(wallet1.address)).to.almostEqual('0');
            await token.addPod(farm.address);
            expect(await farm.farmed(wallet1.address)).to.almostEqual('0');

            await time.increaseTo(started + time.duration.weeks(2));

            // 72000 UDSC per week for 1 weeks
            await farm.startFarming('72000', time.duration.weeks(1));
            await time.increaseTo(started + time.duration.weeks(3));

            expect(await farm.farmed(wallet1.address)).to.almostEqual('72000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('0');
        });

        /*
            ***Test Scenario**
            Three stakers with the different (1:3:5) stakes wait 3 weeks
            ```
            1x: 72k =>  +-------+ 72k => +-------+ 72k => +-------+ = 18k for 1w +  8k for 2w + 12k for 3w
            3x:         +-------+        +-------+                  = 54k for 1w + 24k for 2w +  0k for 3w
            5x:                          +-------+        +-------+ =  0k for 1w + 40k for 2w + 60k for 3w
            ```

            ***Initial setup**
            - `farm` has started farming **72k** for **1 week**
            - `wallet1` has 1 farmable token and joined the `farm`
            - `wallet2` has 3 farmable token and joined the `farm`
            - `wallet3` has 5 farmable token and hasn't joined the `farm`

            ***Test steps and expected rewards**
            |#  |Test Steps|`wallet1`|`wallet2`|`wallet3`|
            |---|----------|---------|---------|---------|
            |1. |Fast-forward => **week 1**                 |18k|54k|0|
            |2. |`wallet3` joins `farm`                     |18k|54k|0|
            |3. |`farm` starts new farming 72k for 1 week   |18k|54k|0|
            |4. |Fast-forward => **week 2**                 |26k|78k|40k|
            |5. |`wallet2` removePods `farm`                     |26k|78k|40k|
            |6. |`farm` starts new farming 72k for 1 week   |26k|78k|40k|
            |7. |Fast-forward => **week 3**                 |38k|78k|100k|

        */
        it('Three stakers with the different (1:3:5) stakes wait 3 weeks', async function () {
            const { token, farm } = await loadFixture(initContracts);
            //
            // 1x: +----------------+--------+ = 18k for 1w +  8k for 2w + 12k for 3w
            // 3x: +----------------+          = 54k for 1w + 24k for 2w +  0k for 3w
            // 5x:         +-----------------+ =  0k for 1w + 40k for 2w + 60k for 3w
            //
            const recipientAmount = INITIAL_SUPPLY / 3n;
            await token.transfer(wallet2.address, recipientAmount);
            const anotherAccountAmount = INITIAL_SUPPLY * 5n / 9n;
            await token.transfer(wallet3.address, anotherAccountAmount);

            // 72000 UDSC per week for 3 weeks
            const started = await startFarming(farm, '72000', time.duration.weeks(1), wallet1);

            await token.addPod(farm.address);
            await token.connect(wallet2).addPod(farm.address);

            await time.increaseTo(started + time.duration.weeks(1));

            await token.connect(wallet3).addPod(farm.address);

            // expect(await token.farmedPerToken()).to.almostEqual('18000');
            expect(await farm.farmed(wallet1.address)).to.almostEqual('18000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('54000');

            await farm.startFarming('72000', time.duration.weeks(1));
            await time.increaseTo(started + time.duration.weeks(2));

            // expect(await token.farmedPerToken()).to.almostEqual('26000'); // 18k + 8k
            expect(await farm.farmed(wallet1.address)).to.almostEqual('26000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('78000');
            expect(await farm.farmed(wallet3.address)).to.almostEqual('40000');

            await token.connect(wallet2).removePod(farm.address);

            await farm.startFarming('72000', time.duration.weeks(1));
            await time.increaseTo(started + time.duration.weeks(3));

            // expect(await token.farmedPerToken()).to.almostEqual('38000'); // 18k + 8k + 12k
            expect(await farm.farmed(wallet1.address)).to.almostEqual('38000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('78000');
            expect(await farm.farmed(wallet3.address)).to.almostEqual('100000');
        });

        /*
            ***Test Scenario**
            Three stakers with the different (1:3:5) stakes wait 3 weeks for 1 farming event
            ```
            1x: 216k => +---------------------+ = 18k for 1w +  8k for 2w + 12k for 3w
            3x:         +--------------+        = 54k for 1w + 24k for 2w +  0k for 3w
            5x:                +--------------+ =  0k for 1w + 40k for 2w + 60k for 3w
            ```

            ***Initial setup**
            - `farm` has started farming **216k** for **3 weeks**
            - `wallet1` has 1 farmable token and joined the `farm`
            - `wallet2` has 3 farmable token and joined the `farm`
            - `wallet3` has 5 farmable token and hasn't joined the `farm`

            ***Test steps and expected rewards**
            |#  |Test Steps|`wallet1`|`wallet2`|`wallet3`|
            |---|----------|---------|---------|---------|
            |1. |Fast-forward => **week 1**                 |18k|54k|0|
            |2. |`wallet3` joins `farm`                     |18k|54k|0|
            |3. |Fast-forward => **week 2**                 |26k|78k|40k|
            |4. |`wallet2` removePods `farm`                     |26k|78k|40k|
            |5. |Fast-forward => **week 3**                 |38k|78k|100k|

        */
        it('Three stakers with the different (1:3:5) stakes wait 3 weeks for 1 farming event', async function () {
            const { token, farm } = await loadFixture(initContracts);
            //
            // 1x: +-------------------------+ = 18k for 1w +  8k for 2w + 12k for 3w
            // 3x: +----------------+          = 54k for 1w + 24k for 2w +  0k for 3w
            // 5x:         +-----------------+ =  0k for 1w + 40k for 2w + 60k for 3w
            //
            const recipientAmount = INITIAL_SUPPLY / 3n;
            await token.transfer(wallet2.address, recipientAmount);
            const anotherAccountAmount = INITIAL_SUPPLY * 5n / 9n;
            await token.transfer(wallet3.address, anotherAccountAmount);

            // 72000 UDSC per week for 3 weeks
            const started = await startFarming(farm, '216000', time.duration.weeks(3), wallet1);

            await token.addPod(farm.address);
            await token.connect(wallet2).addPod(farm.address);

            await time.increaseTo(started + time.duration.weeks(1));

            await token.connect(wallet3).addPod(farm.address);

            // expect(await token.farmedPerToken()).to.almostEqual('18000');
            expect(await farm.farmed(wallet1.address)).to.almostEqual('18000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('54000');

            await time.increaseTo(started + time.duration.weeks(2));

            await token.connect(wallet2).removePod(farm.address);

            expect(await farm.farmed(wallet1.address)).to.almostEqual('26000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('78000');
            expect(await farm.farmed(wallet3.address)).to.almostEqual('40000');

            await time.increaseTo(started + time.duration.weeks(3));

            // expect(await token.farmedPerToken()).to.almostEqual('38000'); // 18k + 8k + 12k
            expect(await farm.farmed(wallet1.address)).to.almostEqual('38000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('78000');
            expect(await farm.farmed(wallet3.address)).to.almostEqual('100000');
        });

        /*
            ***Test Scenario**
            Add more farming reward before previous farming finished
            ```
            1x: 10k => +-------+ = 2750 for 1w
            3x:  1k => +-------+ = 8250 for 1w
            ```

            ***Initial setup**
            - `farm` has started farming **10k** for **1 weeks**
            - `wallet1` has 1 farmable token and joined the `farm`
            - `wallet2` has 3 farmable token and joined the `farm`

            ***Test steps and expected rewards**
            |#  |Test Steps|`wallet1`|`wallet2`|
            |---|----------|---------|---------|
            |1. |`farm` starts new farming 1k for 1 week    |0|0|
            |2. |Fast-forward => **week 1**                 |2720|8250|

        */
        it('Notify Reward Amount before prev farming finished', async function () {
            const { token, farm } = await loadFixture(initContracts);
            await token.transfer(wallet2.address, INITIAL_SUPPLY / 4n);

            // 10000 UDSC per week for 1 weeks
            const started = await startFarming(farm, '10000', time.duration.weeks(1), wallet1);

            // expect(await token.farmedPerToken()).to.equal('0');
            expect(await farm.farmed(wallet1.address)).to.equal('0');
            expect(await farm.farmed(wallet2.address)).to.equal('0');

            // 1000 UDSC per week for 1 weeks
            await farm.startFarming('1000', time.duration.weeks(1));

            await token.addPod(farm.address);
            await token.connect(wallet2).addPod(farm.address);

            await time.increaseTo(started + time.duration.weeks(1) + 2);

            // expect(await token.farmedPerToken()).to.almostEqual('2750');
            expect(await farm.farmed(wallet1.address)).to.almostEqual('8250');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('2750');
        });

        /*
            ***Test Scenario**
            Checks that a farm can successfully operate with the reward value equal to max allowed value.

            Currently _MAX_REWARD_AMOUNT = 10^32. Need to update test if contract changes this constant.

            ***Initial setup**
            - Mint and approve _MAX_REWARD_AMOUNT to `farm`

            ***Test Steps**
            1. A wallet joins farm.
            2. Start farming with _MAX_REWARD_AMOUNT as a reward for 1 week.
            3. Fast forward time for 1 week.
            4. Check the wallet's reward amount.
            5. Claim the reward.

            ***Expected results**
            1. Join, check reward and claim operations completed succesfully.
            2. Claimed reward equals to _MAX_REWARD_AMOUNT.
        */
        it('Operate farm with max allowed reward', async function () {
            const { token, gift, farm } = await loadFixture(initContracts);
            const _MAX_REWARD_AMOUNT = 10n ** 32n;

            await gift.mint(wallet1.address, _MAX_REWARD_AMOUNT);
            await gift.approve(farm.address, _MAX_REWARD_AMOUNT);

            await token.addPod(farm.address);
            const started = await startFarming(farm, _MAX_REWARD_AMOUNT, time.duration.weeks(1), wallet1);
            await time.increaseTo(started + time.duration.weeks(1));
            expect(await farm.farmed(wallet1.address)).to.almostEqual(_MAX_REWARD_AMOUNT);

            const balanceBeforeClaim = await gift.balanceOf(wallet1.address);
            await farm.claim();
            expect(await gift.balanceOf(wallet1.address)).to.almostEqual(balanceBeforeClaim.add(_MAX_REWARD_AMOUNT));
        });

        /*
            ***Test Scenario**
            Checks that a farm not credited rewards after farming time expires.

            Currently _MAX_REWARD_AMOUNT = 10^32. Need to update test if contract changes this constant.

            ***Initial setup**
            - Mint and approve _MAX_REWARD_AMOUNT to `farm`

            ***Test Steps**
            1. Start farming with _MAX_REWARD_AMOUNT as a reward for 1 week.
            2. A wallet joins farm.
            3. Fast forward time for 1 week.
            4. Check the wallet's reward amount doesn't increase after this time.

            ***Expected results**
            1. Reward increase stops after 1 week from start farming.
        */
        it('Farm operation time', async function () {
            const { token, gift, farm } = await loadFixture(initContracts);
            const _MAX_REWARD_AMOUNT = 10n ** 32n;

            await gift.mint(wallet1.address, _MAX_REWARD_AMOUNT);
            await gift.approve(farm.address, _MAX_REWARD_AMOUNT);

            const started = await startFarming(farm, _MAX_REWARD_AMOUNT, time.duration.weeks(1), wallet1);
            await token.addPod(farm.address);

            await time.increaseTo(started + time.duration.weeks(1));
            const farmedAmount = await farm.farmed(wallet1.address);
            for (let i = 1; i < 5; i++) {
                await time.increaseTo(started + time.duration.weeks(1) + i);
                expect(await farm.farmed(wallet1.address)).to.equal(farmedAmount);
            }
        });
    });

    // Token transfer scenarios
    describe('transfers', function () {
        /*
            ***Test Scenario**
            Transfer from one wallet to another, both are farming
            ```
            72k => 2x: +-------+ 1х: +--------+   = 9k  for 1w + 27k for 2w = 36
            #      1x: +-------+ 2x: +--------+   = 27k for 1w +  9k for 2w = 36
            ```

            ***Initial setup**
            - `farm` has started farming **72k** for **2 weeks**
            - `wallet1` has 1 farmable token and joined the `farm`
            - `wallet2` has 3 farmable token and joined the `farm`

            ***Test steps and expected rewards**
            |#  |Test Steps|`wallet1`|`wallet2`|
            |---|----------|---------|---------|
            |1. |Fast-forward => **week 1**                             |9k|27k|
            |2. |Transfer 2 farmable tokens from `wallet2` to `wallet1` |9k|27k|
            |3. |Fast-forward => **week 2**                             |36k|36k|

        */
        it('Transfer from one wallet to another, both farming', async function () {
            const { token, farm } = await loadFixture(initContracts);
            //
            // 2x: +-------+ 1х+--------+   = 9k  for 1w + 27k for 2w = 36
            // 1x: +-------+ 2x+--------+   = 27k for 1w +  9k for 2w = 36
            //
            await token.transfer(wallet2.address, INITIAL_SUPPLY / 4n);

            // 36000 UDSC per week for 2 weeks
            const started = await startFarming(farm, '72000', time.duration.weeks(2), wallet1);

            await token.addPod(farm.address);
            await token.connect(wallet2).addPod(farm.address);

            await time.increaseTo(started + time.duration.weeks(1));

            expect(await farm.farmed(wallet1.address)).to.almostEqual('27000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('9000');

            await token.transfer(wallet2.address, INITIAL_SUPPLY / 2n);

            await time.increaseTo(started + time.duration.weeks(2));

            expect(await farm.farmed(wallet1.address)).to.almostEqual('36000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('36000');
        });

        // ```
        // 1x: +-------+--------+   = 18k for 1w + 36k for 2w
        // 1x: +-------+            = 18k for 1w +  0k for 2w
        // ```
        /*
            ***Test Scenario**
            Transfer from one wallet to another, sender is farming, reciever is not farming
            ```
            72k => 1x: +-------+ 1х: +--------+   = 9k  for 1w + 27k for 2w = 36
            #      1x: +-------+ 0x: +        +   = 27k for 1w +  9k for 2w = 36
            ```

            ***Initial setup**
            - `farm` has started farming **72k** for **2 weeks**
            - `wallet1` has 1 farmable token and joined the `farm`
            - `wallet2` has 1 farmable token and joined the `farm`
            - `wallet3` has no farmable token and hasn't joined the `farm`

            ***Test steps and expected rewards**
            |#  |Test Steps|`wallet1`|`wallet2`|
            |---|----------|---------|---------|
            |1. |Fast-forward => **week 1**                             |18k|18k|
            |2. |Transfer 2 farmable tokens from `wallet2` to `wallet3` |18k|18k|
            |3. |Fast-forward => **week 2**                             |54k|18k|

        */
        it('Transfer from one wallet to another, sender is farming, reciever is not farming', async function () {
            const { token, farm } = await loadFixture(initContracts);
            //
            // 1x: +-------+--------+   = 18k for 1w + 36k for 2w
            // 1x: +-------+            = 18k for 1w +  0k for 2w
            //
            await token.transfer(wallet2.address, INITIAL_SUPPLY / 2n);

            // 36000 UDSC per week for 2 weeks
            const started = await startFarming(farm, '72000', time.duration.weeks(2), wallet1);

            await token.addPod(farm.address);
            await token.connect(wallet2).addPod(farm.address);

            await time.increaseTo(started + time.duration.weeks(1));

            expect(await farm.farmed(wallet1.address)).to.almostEqual('18000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('18000');

            await token.connect(wallet2).transfer(wallet3.address, INITIAL_SUPPLY / 2n);

            await time.increaseTo(started + time.duration.weeks(2));

            // expect(await token.farmedPerToken()).to.almostEqual('38000'); // 18k + 8k + 12k
            expect(await farm.farmed(wallet1.address)).to.almostEqual('54000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('18000');
        });

        /*
            ***Test Scenario**
            Transfer farming token to farming wallet in the middle of farming
            ```
            72k => 1x: +-------+ 3х: +--------+   = 18k  for 1w + 27k for 2w = 36
            #      1x: +-------+ 1x: +--------+   = 18k for 1w +  9k for 2w = 36
            ```

            ***Initial setup**
            - `farm` has started farming **72k** for **2 weeks**
            - `wallet1` has 1 farmable token and joined the `farm`
            - `wallet2` has 1 farmable token and joined the `farm`
            - `wallet3` has 2 farmable token and hasn't joined the `farm`

            ***Test steps and expected rewards**
            |#  |Test Steps|`wallet1`|`wallet2`|
            |---|----------|---------|---------|
            |1. |Fast-forward => **week 1**                             |18k|18k|
            |2. |Transfer 2 farmable tokens from `wallet3` to `wallet1` |18k|18k|
            |3. |Fast-forward => **week 2**                             |45k|27k|

        */
        it('Transfer from one wallet to another, sender is not farming, reciever is farming', async function () {
            const { token, farm } = await loadFixture(initContracts);
            await token.transfer(wallet2.address, INITIAL_SUPPLY / 4n);
            await token.transfer(wallet3.address, INITIAL_SUPPLY / 2n);

            // 36000 UDSC per week for 2 weeks
            const started = await startFarming(farm, '72000', time.duration.weeks(2), wallet1);

            await token.addPod(farm.address);
            await token.connect(wallet2).addPod(farm.address);

            await time.increaseTo(started + time.duration.weeks(1));

            expect(await farm.farmed(wallet1.address)).to.almostEqual('18000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('18000');

            await token.connect(wallet3).transfer(wallet1.address, INITIAL_SUPPLY / 2n);

            await time.increaseTo(started + time.duration.weeks(2));

            expect(await farm.farmed(wallet1.address)).to.almostEqual('45000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('27000');
        });

        /*
            ***Test Scenario**
            Transfer from one wallet to another, both are not farming
            ```
            72k => 0x: +       + 1х: +--------+   = 0k for 1w +  9k for 2w
            #      0x: +       + 3x: +--------+   = 0k for 1w + 27k for 2w
            ```

            ***Initial setup**
            - `farm` has started farming **72k** for **2 weeks**
            - `wallet1` has 1 farmable token and has not joined the `farm`
            - `wallet2` has 1 farmable token and has not joined the `farm`

            ***Test steps and expected rewards**
            |#  |Test Steps|`wallet1`|`wallet2`|
            |---|----------|---------|---------|
            |1. |Fast-forward => **week 1**                             |0|0|
            |3. |Transfer 3 from `wallet1` to `wallet2`                 |0|0|
            |2. |`wallet1` and `wallet2` join the `farm`                |0|0|
            |4. |Fast-forward => **week 2**                             |27k|9k|

        */
        it('Transfer from one wallet to another, both are not farming', async function () {
            const { token, farm } = await loadFixture(initContracts);
            const started = await startFarming(farm, '72000', time.duration.weeks(2), wallet1);

            await time.increaseTo(started + time.duration.weeks(1));

            await token.transfer(wallet2.address, INITIAL_SUPPLY / 4n);

            await token.addPod(farm.address);
            await token.connect(wallet2).addPod(farm.address);

            expect(await farm.farmed(wallet1.address)).to.equal('0');
            expect(await farm.farmed(wallet2.address)).to.equal('0');

            await time.increaseTo(started + time.duration.weeks(2));

            expect(await farm.farmed(wallet1.address)).to.almostEqual('27000');
            expect(await farm.farmed(wallet2.address)).to.almostEqual('9000');
        });
    });
});
